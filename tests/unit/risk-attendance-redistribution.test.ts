import { describe, expect, it } from "vitest";
import { classifyShift, summarizeAttendance, type ShiftRecord } from "@/lib/analytics/attendance";
import { scoreFacility, type FacilitySignals } from "@/lib/analytics/risk";
import { donorSurplus, haversineKm, recipientNeed, recommendTransfers, type StockPosition } from "@/lib/analytics/redistribution";
import { batchExpiryRisk, expiryOptimizer } from "@/lib/analytics/expiry";
import { RISK_WEIGHTS } from "@/lib/config/rules";
import { addDays } from "@/lib/dates";

const T = "2026-10-18";

describe("facility risk score", () => {
  const calm: FacilitySignals = {
    medicinesTracked: 10, medicinesCritical: 0, medicinesHigh: 0, projectedDailyFootfall: 40, opdCapacity: 100,
    bedsOperational: 10, bedsOccupied: 3, doctorCoverage: 1, unverifiedShare: 0, essentialDiagnostics: 5,
    essentialUnavailable: 0, essentialLimited: 0, hoursSinceUpdate: 2,
  };
  it("scores a healthy facility low", () => {
    const r = scoreFacility(calm);
    expect(r.score).toBe(0);
    expect(r.band).toBe("low");
  });
  it("saturates to the full weight sum in the worst case and stays within 0–100", () => {
    const r = scoreFacility({ ...calm, medicinesCritical: 10, projectedDailyFootfall: 500, bedsOccupied: 10, doctorCoverage: 0, unverifiedShare: 1, essentialUnavailable: 5, hoursSinceUpdate: 500 });
    const total = Object.values(RISK_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(r.score).toBe(total);
    expect(r.band).toBe("high");
  });
  it("missing data contributes 0 and is reported, never guessed", () => {
    const r = scoreFacility({ ...calm, medicinesTracked: 0, bedsOperational: 0, doctorCoverage: null, projectedDailyFootfall: null, essentialDiagnostics: 0 });
    expect(r.missingData.sort()).toEqual(["bed_utilization", "diagnostics", "medicine_shortage", "projected_demand", "staffing_gap"]);
  });
  it("unknown data freshness is treated as stale (worst)", () => {
    const f = scoreFacility({ ...calm, hoursSinceUpdate: null }).factors.find((x) => x.key === "data_freshness")!;
    expect(f.normalized).toBe(1);
  });
  it("factors are sorted by contribution and sum to the score", () => {
    const r = scoreFacility({ ...calm, medicinesCritical: 2, bedsOccupied: 9 });
    expect(Math.round(r.factors.reduce((a, f) => a + f.contribution, 0))).toBe(r.score);
    for (let i = 1; i < r.factors.length; i++) expect(r.factors[i - 1].contribution).toBeGreaterThanOrEqual(r.factors[i].contribution);
  });
});

describe("attendance classification", () => {
  const rec = (o: Partial<ShiftRecord>): ShiftRecord => ({ shiftId: "s", staffId: "d", isDoctor: true, shiftDate: addDays(T, -1), shiftType: "morning", status: null, verification: null, ...o });
  it("missing past record is INCOMPLETE, never absent", () => {
    expect(classifyShift(rec({}), T)).toBe("incomplete");
  });
  it("today without record is pending; future is scheduled", () => {
    expect(classifyShift(rec({ shiftDate: T }), T)).toBe("pending");
    expect(classifyShift(rec({ shiftDate: addDays(T, 1) }), T)).toBe("scheduled");
  });
  it("absent is only 'absent_verified' once verified", () => {
    expect(classifyShift(rec({ status: "absent", verification: "unverified" }), T)).toBe("unverified");
    expect(classifyShift(rec({ status: "absent", verification: "verified" }), T)).toBe("absent_verified");
  });
  it("summary flags days without any present doctor and excludes leave from coverage", () => {
    const s = summarizeAttendance(
      [rec({ status: "approved_leave", verification: "verified" }), rec({ staffId: "d2", status: "absent", verification: "verified" }), rec({ shiftDate: addDays(T, -2), status: "present", verification: "verified" })],
      T,
      0.35,
    );
    expect(s.daysWithoutDoctor).toEqual([addDays(T, -1)]);
    expect(s.doctorCoverage).toBe(0.5); // 1 present of 2 non-leave shifts
    expect(s.needsReview).toBe(true);
  });
  it("empty roster gives null coverage, not 0%", () => {
    expect(summarizeAttendance([], T, 0.35).doctorCoverage).toBeNull();
  });
});

const pos = (o: Partial<StockPosition> & { facilityId: string }): StockPosition => ({
  facilityName: o.facilityId, medicineId: "M", medicineName: "Med", unit: "tablet", latitude: 25.4, longitude: 82.0, batches: [],
  usable: 0, dailyDemand: 10, safetyStock: 70, leadTimeDays: 10, risk: "ok", daysUntilStockout: null, deliveries: [], ...o,
});
const batch = (qty: number, days: number, n = "B") => ({ id: n, batchNumber: n, quantity: qty, expiryDate: addDays(T, days) });

describe("redistribution maths", () => {
  it("haversine distance is symmetric and ~111 km per degree of latitude", () => {
    const a = { lat: 25, lon: 82 }, b = { lat: 26, lon: 82 };
    expect(haversineKm(a, b)).toBeCloseTo(111.2, 0);
    expect(haversineKm(a, b)).toBeCloseTo(haversineKm(b, a), 9);
  });
  it("recipient need bridges only until a delivery inside the window", () => {
    const p = pos({ facilityId: "R", usable: 30, deliveries: [{ quantity: 999, expectedDate: addDays(T, 5) }] });
    expect(recipientNeed(p, T)).toMatchObject({ need: 10 * 5 + 70 - 30, window: 5 });
  });
  it("donor surplus never includes stock under the minimum shelf life", () => {
    const p = pos({ facilityId: "D", usable: 2000, batches: [batch(1500, 10, "SOON"), batch(500, 300, "LATER")] });
    const s = donorSurplus(p, T);
    expect(s.transferable).toBe(500);
    expect(s.surplus).toBeLessThanOrEqual(500);
  });
  it("no recommendation without a recipient at risk", () => {
    expect(recommendTransfers([pos({ facilityId: "A" }), pos({ facilityId: "B" })], T)).toEqual([]);
  });
});

describe("near-expiry optimizer", () => {
  it("FEFO simulation: only the part that cannot be used locally is at risk", () => {
    const p = pos({ facilityId: "D", usable: 1000, batches: [batch(1000, 40, "N")] });
    const [r] = batchExpiryRisk(p, T);
    expect(r.usedLocally).toBe(410); // 10/day × 41 days
    expect(r.atRisk).toBe(590);
    expect(r.movable).toBe(true);
  });
  it("batches too close to expiry are flagged but never proposed for transfer", () => {
    const donor = pos({ facilityId: "D", usable: 1000, batches: [batch(1000, 15, "X")] });
    const rcp = pos({ facilityId: "R", usable: 0, longitude: 82.01 });
    const { risks, recs } = expiryOptimizer([donor, rcp], new Map(), T);
    expect(risks[0].movable).toBe(false);
    expect(recs).toHaveLength(0);
  });
  it("proposes a transfer the recipient can consume before expiry without breaching donor safety", () => {
    const donor = pos({ facilityId: "D", usable: 1000, batches: [batch(1000, 40, "N")] });
    const rcp = pos({ facilityId: "R", usable: 0, longitude: 82.01, dailyDemand: 20 });
    const { recs } = expiryOptimizer([donor, rcp], new Map(), T);
    expect(recs.length).toBeGreaterThan(0);
    expect(recs[0].quantity).toBeLessThanOrEqual(recs[0].recipientCanConsume);
    expect(recs[0].donorRemainingAfter).toBeGreaterThanOrEqual(donor.safetyStock);
  });
  it("no near-expiry stock → nothing at risk", () => {
    expect(expiryOptimizer([pos({ facilityId: "D", usable: 100, batches: [batch(100, 300)] })], new Map(), T).risks).toEqual([]);
  });
});
