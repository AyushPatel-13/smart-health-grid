import { afterEach, describe, expect, it, vi } from "vitest";
import { can, canWriteFacility, type AppUser } from "@/lib/auth/permissions";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { addDays, dateRange, diffDays, isValidDay, istInstant, toISTDate, weekday } from "@/lib/dates";
import { DbError, toDbError } from "@/lib/db/types";
import { createTranslator, formatNumber, formatPct, getDictionary, interpolate, normalizeLocale } from "@/lib/i18n";
import { addBatchSchema, adjustmentSchema, alertActionSchema, bedSchema, patientStatsSchema, reviewTransferSchema, userSchema } from "@/lib/validation/schemas";
import { slotInstant, windowBounds } from "@/lib/allocation/service";
import { enqueue, flushQueue, isNetworkError, listQueued } from "@/lib/offline/queue";

const ID = "11111111-1111-4111-8111-111111111111";
const user = (role: AppUser["role"], facilityId: string | null = null): AppUser => ({
  id: ID, email: "x@y.z", fullName: "X", role, districtId: null, facilityId, facilityName: null, facilityNameHi: null, facilityCode: null, districtName: null, districtNameHi: null,
});

describe("role-based permissions", () => {
  it("read-only officials cannot write anything", () => {
    for (const p of ["operations:write", "alerts:manage", "transfers:review", "admin:manage"] as const) expect(can(user("read_only"), p)).toBe(false);
    expect(can(user("read_only"), "audit:view")).toBe(true);
    expect(canWriteFacility(user("read_only"), ID)).toBe(false);
  });
  it("staff write only their own facility and cannot approve", () => {
    const s = user("facility_staff", ID);
    expect(canWriteFacility(s, ID)).toBe(true);
    expect(canWriteFacility(s, "22222222-2222-4222-8222-222222222222")).toBe(false);
    expect(can(s, "transfers:review")).toBe(false);
    expect(can(s, "transfers:request")).toBe(true);
  });
  it("anonymous has no permissions", () => {
    expect(can(null, "audit:view")).toBe(false);
    expect(canWriteFacility(null, ID)).toBe(false);
  });
});

describe("password hashing", () => {
  it("verifies the right password only and salts each hash", () => {
    const h = hashPassword("Secret@123");
    expect(verifyPassword("Secret@123", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(hashPassword("Secret@123")).not.toBe(h);
  });
  it("rejects malformed / missing hashes", () => {
    expect(verifyPassword("x", null)).toBe(false);
    expect(verifyPassword("x", "md5$abc")).toBe(false);
  });
});

describe("input validation schemas", () => {
  const key = "idem-key-123456";
  it("rejects zero/negative/fractional stock quantities", () => {
    for (const quantity of [0, -5, 1.5]) {
      expect(addBatchSchema.safeParse({ facilityId: ID, medicineId: ID, batchNumber: "AB-1", quantity, expiryDate: "2030-01-01", source: "state_supply", idempotencyKey: key }).success).toBe(false);
    }
  });
  it("rejects invalid batch numbers and dates", () => {
    expect(addBatchSchema.safeParse({ facilityId: ID, medicineId: ID, batchNumber: "bad batch!", quantity: 5, expiryDate: "2030-01-01", source: "state_supply", idempotencyKey: key }).success).toBe(false);
    expect(addBatchSchema.safeParse({ facilityId: ID, medicineId: ID, batchNumber: "AB-1", quantity: 5, expiryDate: "2030-02-30", source: "state_supply", idempotencyKey: key }).success).toBe(false);
  });
  it("adjustments require a non-zero quantity and a reason", () => {
    expect(adjustmentSchema.safeParse({ batchId: ID, quantity: 0, reason: "damaged", idempotencyKey: key }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ batchId: ID, quantity: -3, reason: "no", idempotencyKey: key }).success).toBe(false);
    expect(adjustmentSchema.safeParse({ batchId: ID, quantity: -3, reason: "Damaged in storage", idempotencyKey: key }).success).toBe(true);
  });
  it("beds: occupied + out-of-service cannot exceed total", () => {
    const r = bedSchema.safeParse({ facilityId: ID, wardId: null, ward: "General", totalBeds: 5, occupiedBeds: 4, outOfServiceBeds: 2 });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].message).toBe("beds.exceeds");
    expect(bedSchema.safeParse({ facilityId: ID, wardId: null, ward: "General", totalBeds: 5, occupiedBeds: 3, outOfServiceBeds: 2 }).success).toBe(true);
  });
  it("footfall corrections require a reason", () => {
    const base = { facilityId: ID, statDate: "2026-10-01", opdVisits: 10, ipdAdmissions: 0, emergencyVisits: 0, notes: null };
    expect(patientStatsSchema.safeParse({ ...base, isCorrection: true, correctionReason: "" }).success).toBe(false);
    expect(patientStatsSchema.safeParse({ ...base, isCorrection: true, correctionReason: "Typo in register" }).success).toBe(true);
  });
  it("rejecting a transfer or resolving an alert requires notes", () => {
    expect(reviewTransferSchema.safeParse({ transferId: ID, decision: "reject", notes: "" }).success).toBe(false);
    expect(alertActionSchema.safeParse({ alertId: ID, action: "resolve", notes: "ok" }).success).toBe(false);
    expect(alertActionSchema.safeParse({ alertId: ID, action: "assign" }).success).toBe(false);
  });
  it("staff users must have a facility", () => {
    expect(userSchema.safeParse({ email: "a@b.co", fullName: "A B", role: "facility_staff", facilityId: "", isActive: true }).success).toBe(false);
  });
});

describe("DB error mapping", () => {
  it("maps known codes and Postgres error classes", () => {
    expect(toDbError(new Error("INSUFFICIENT_STOCK")).code).toBe("INSUFFICIENT_STOCK");
    expect(toDbError({ message: "new row violates row-level security policy", code: "42501" }).code).toBe("FORBIDDEN");
    expect(toDbError({ message: "dup", code: "23505" }).code).toBe("DUPLICATE");
    expect(toDbError({ message: "chk", code: "23514" }).code).toBe("CONSTRAINT");
    expect(toDbError("weird").code).toBe("UNKNOWN");
    const e = new DbError("X", "y");
    expect(toDbError(e)).toBe(e);
  });
});

describe("dates (IST)", () => {
  it("handles month/year boundaries and validation", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(diffDays("2026-02-27", "2026-03-01")).toBe(2);
    expect(dateRange("2026-10-01", "2026-10-03")).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(dateRange("2026-10-03", "2026-10-01")).toEqual([]);
    expect(isValidDay("2026-02-29")).toBe(false);
    expect(isValidDay("2028-02-29")).toBe(true);
    expect(weekday("2026-10-18")).toBe(0); // Sunday
  });
  it("converts instants to IST calendar days", () => {
    expect(toISTDate("2026-10-17T19:00:00Z")).toBe("2026-10-18"); // 00:30 IST
    expect(istInstant("2026-10-18", 9)).toBe("2026-10-18T03:30:00.000Z");
  });
});

describe("allocation windows", () => {
  it("aligns windows to the configured length in IST", () => {
    const { start, cutoff } = windowBounds(new Date("2026-10-18T05:23:00Z"), 60); // 10:53 IST
    expect(start.toISOString()).toBe("2026-10-18T04:30:00.000Z");
    expect(cutoff.toISOString()).toBe("2026-10-18T05:30:00.000Z");
    expect(slotInstant("2026-10-19", "10:00").toISOString()).toBe("2026-10-19T04:30:00.000Z");
  });
});

describe("i18n", () => {
  it("interpolates params and keeps numbers in Indian grouping", () => {
    expect(interpolate("{a} of {b}", { a: 1500000, b: null })).toBe("15,00,000 of —");
    expect(formatPct(0.856)).toBe("86%");
    expect(formatNumber(null)).toBe("—");
    expect(normalizeLocale("fr")).toBe("en");
  });
  it("falls back to English, then to the key, for missing translations", () => {
    const { tx } = createTranslator(getDictionary("hi"));
    expect(tx("nav.dashboard")).toBe("डैशबोर्ड");
    expect(tx("does.not.exist")).toBe("does.not.exist");
  });
});

describe("offline queue", () => {
  const store = new Map<string, string>();
  const setup = (online: boolean) => {
    store.clear();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal("window", { dispatchEvent: () => true });
    vi.stubGlobal("navigator", { onLine: online });
  };
  afterEach(() => vi.unstubAllGlobals());

  it("classifies network vs business errors", () => {
    setup(true);
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError(new Error("INSUFFICIENT_STOCK"))).toBe(false);
  });
  it("syncs queued items once, and keeps business conflicts for review instead of retrying", async () => {
    setup(true);
    enqueue("checkin", { a: 1 });
    enqueue("issue", { b: 2 });
    const calls: string[] = [];
    const out = await flushQueue({
      register: async () => ({ ok: true }),
      checkin: async () => (calls.push("checkin"), { ok: true }),
      issue: async () => (calls.push("issue"), { ok: false, error: "INSUFFICIENT_STOCK" }),
    });
    expect(out.map((o) => o.ok)).toEqual([true, false]);
    expect(listQueued()).toMatchObject([{ kind: "issue", status: "failed", error: "INSUFFICIENT_STOCK" }]);
    await flushQueue({ register: async () => ({ ok: true }), checkin: async () => ({ ok: true }), issue: async () => (calls.push("issue"), { ok: true }) });
    expect(calls).toEqual(["checkin", "issue"]); // failed item not auto-retried
  });
  it("does nothing while offline and keeps items when the network drops mid-sync", async () => {
    setup(false);
    enqueue("register", { x: 1 });
    expect(await flushQueue({ register: async () => ({ ok: true }), checkin: async () => ({ ok: true }), issue: async () => ({ ok: true }) })).toEqual([]);
    vi.stubGlobal("navigator", { onLine: true });
    await flushQueue({ register: async () => { throw new TypeError("Failed to fetch"); }, checkin: async () => ({ ok: true }), issue: async () => ({ ok: true }) });
    expect(listQueued()).toMatchObject([{ kind: "register", status: "queued" }]);
  });
});
