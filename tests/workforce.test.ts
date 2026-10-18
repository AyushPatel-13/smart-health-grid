import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateAttendance, type CheckInput } from "@/lib/workforce/geofence";
import { loadSnapshots } from "@/lib/data/snapshot";
import { computeWorkload, redeploymentRecommendations } from "@/lib/workforce/service";
import { WORKFORCE_RULES } from "@/lib/config/rules";
import { todayIST } from "@/lib/dates";
import { createTestDb, type TestDb } from "./helpers/db";

const today = todayIST();
// 08:05 IST today (5 min after a morning shift start).
const at = (h: number, m = 0) => new Date(Date.parse(`${today}T00:00:00Z`) - 330 * 60_000 + (h * 60 + m) * 60_000);
const base: CheckInput = {
  event: "check_in",
  distanceM: 40,
  accuracyM: 12,
  locationAgeS: 5,
  radiusM: 250,
  identityOk: true,
  simulated: false,
  shiftType: "morning",
  shiftDate: today,
  now: at(8, 5),
};

describe("mobile attendance verification rules", () => {
  it("accepts a valid on-time check-in inside the geofence", () => {
    expect(evaluateAttendance(base)).toEqual({ result: "accepted", reasons: [], dutyMinutes: null });
  });
  it("incorrect location → manual review (not absence)", () => {
    const r = evaluateAttendance({ ...base, distanceM: 1200 });
    expect(r.result).toBe("needs_review");
    expect(r.reasons).toContain("outside_geofence");
  });
  it("insufficient GPS accuracy → review", () => {
    expect(evaluateAttendance({ ...base, accuracyM: 400 }).reasons).toContain("low_accuracy");
  });
  it("stale location (poor connectivity / cached fix) → review", () => {
    expect(evaluateAttendance({ ...base, locationAgeS: 900 }).reasons).toContain("stale_location");
  });
  it("no location at all (GPS error) → review, never rejected outright", () => {
    const r = evaluateAttendance({ ...base, distanceM: null, accuracyM: null, locationAgeS: null });
    expect(r).toMatchObject({ result: "needs_review", reasons: ["no_location"] });
  });
  it("failed identity confirmation → review", () => {
    expect(evaluateAttendance({ ...base, identityOk: false }).reasons).toContain("identity_failed");
  });
  it("late arrival is recorded but does not by itself fail verification", () => {
    const r = evaluateAttendance({ ...base, now: at(9, 30) });
    expect(r.result).toBe("accepted");
    expect(r.reasons).toEqual(["late"]);
  });
  it("accuracy radius allows a borderline fix that could be inside the fence", () => {
    expect(evaluateAttendance({ ...base, distanceM: 280, accuracyM: 40 }).result).toBe("accepted");
  });
  it("check-out computes duty minutes and flags a very short duty", () => {
    const ok = evaluateAttendance({ ...base, event: "check_out", now: at(14, 0), checkInAt: at(8, 0) });
    expect(ok).toMatchObject({ result: "accepted", dutyMinutes: 360 });
    const short = evaluateAttendance({ ...base, event: "check_out", now: at(9, 0), checkInAt: at(8, 0) });
    expect(short.result).toBe("needs_review");
    expect(short.reasons).toContain("short_duty");
  });
});

let t: TestDb;
let doctor: string;
let admin: string;
let shiftId: string;
beforeAll(async () => {
  t = await createTestDb();
  doctor = await t.user("doctor");
  admin = await t.user("admin");
  const [s] = await t.sys((q) =>
    q.query<{ id: string }>(
      `select s.id from public.shifts s join public.staff st on st.id = s.staff_id where st.profile_id = $1 and s.shift_date = current_date limit 1`,
      [doctor],
    ),
  );
  shiftId = s.id;
});
afterAll(async () => {
  await t?.close();
});

const record = (userId: string, nonce: string, event: string, result: string, reasons: string[] = []) =>
  t.as(userId, (q) =>
    q.query<{ r: string }>(
      `select public.record_mobile_attendance($1, $2, $3, $4, $5::jsonb, 40, 12, 5, now(), 'password_step_up', false, $6) as r`,
      [shiftId, event, nonce, result, JSON.stringify(reasons), event === "check_out" ? 360 : null],
    ),
  );

describe("attendance and workforce (database)", () => {
  it("only the doctor linked to the shift can check in", async () => {
    await expect(record(admin, "n-admin-1", "check_in", "accepted")).rejects.toThrow(/FORBIDDEN/);
  });

  it("check-out before check-in is refused", async () => {
    await expect(record(doctor, "n-out-0", "check_out", "accepted")).rejects.toThrow(/NOT_CHECKED_IN/);
  });

  it("a failed check-in goes to review as PRESENT-unverified, never absent", async () => {
    const [{ r }] = await record(doctor, "n-in-1", "check_in", "needs_review", ["outside_geofence"]);
    expect(r).toBe("needs_review");
    const [a] = await t.sys((q) => q.query<{ status: string; verification_status: string; review_status: string }>(
      `select status, verification_status, review_status from public.attendance where shift_id = $1`, [shiftId]));
    expect(a).toEqual({ status: "present", verification_status: "unverified", review_status: "needs_review" });
  });

  it("replayed requests (same nonce) and duplicate check-ins are not double-counted", async () => {
    const [{ r: replay }] = await record(doctor, "n-in-1", "check_in", "accepted");
    expect(replay).toBe("duplicate:needs_review");
    const [{ r: dup }] = await record(doctor, "n-in-2", "check_in", "accepted");
    expect(dup).toBe("already_checked_in");
    const [{ n }] = await t.sys((q) => q.query<{ n: number }>(`select count(*)::int as n from public.attendance where shift_id = $1`, [shiftId]));
    expect(n).toBe(1);
  });

  it("check-out records the server time and duty; a second check-out is ignored", async () => {
    const [{ r }] = await record(doctor, "n-out-1", "check_out", "accepted");
    expect(r).toBe("accepted");
    const [{ r: again }] = await record(doctor, "n-out-2", "check_out", "accepted");
    expect(again).toBe("already_checked_out");
    const [a] = await t.sys((q) => q.query<{ check_out_at: string | null; duty_minutes: number }>(`select check_out_at, duty_minutes from public.attendance where shift_id = $1`, [shiftId]));
    expect(a.check_out_at).not.toBeNull();
    expect(a.duty_minutes).toBe(360);
  });

  it("admin review resolves the record; staff cannot review", async () => {
    const [a] = await t.sys((q) => q.query<{ id: string }>(`select id from public.attendance where shift_id = $1`, [shiftId]));
    await expect(t.as(doctor, (q) => q.query(`select public.review_attendance($1, true, 'self verify')`, [a.id]))).rejects.toThrow(/FORBIDDEN/);
    await t.as(admin, (q) => q.query(`select public.review_attendance($1, true, 'Confirmed by MO in-charge by phone')`, [a.id]));
    const [after] = await t.sys((q) => q.query<{ review_status: string; verification_status: string }>(`select review_status, verification_status from public.attendance where id = $1`, [a.id]));
    expect(after).toEqual({ review_status: "reviewed", verification_status: "verified" });
  });

  it("workload uses forecast footfall (not registrations) and flags shortfalls", async () => {
    const loads = await t.sys(async (q) => computeWorkload(q, await loadSnapshots(q, { today }), today));
    expect(loads.length).toBeGreaterThan(0);
    for (const l of loads) {
      if (l.requiredHours !== null) expect(l.requiredHours).toBeCloseTo(((l.expectedPatients ?? 0) * WORKFORCE_RULES.consultMinutes) / 60, 0);
      expect(l.shortfallHours).toBeGreaterThanOrEqual(0);
    }
  });

  it("redeployment never takes a doctor from a centre that would fall below its minimum or become unsafe", async () => {
    const recs = await t.sys(async (q) => redeploymentRecommendations(q, await loadSnapshots(q, { today }), today));
    for (const r of recs) {
      for (const o of r.options) {
        expect(o.donorDoctorsAfter).toBeGreaterThanOrEqual(o.donorMinDoctors);
        if (o.donorUtilizationAfter !== null) expect(o.donorUtilizationAfter).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reassignment approval enforces donor minimum staffing and moves the roster", async () => {
    // Pick a PHC doctor (PHC minimum = 1) whose centre has 2 doctors tomorrow.
    const tomorrow = (await t.sys((q) => q.query<{ d: string }>(`select (current_date + 1)::text as d`)))[0].d;
    const [cand] = await t.sys((q) => q.query<{ staff_id: string; facility_id: string; other: number }>(
      `select s.staff_id, s.facility_id,
              (select count(distinct s2.staff_id)::int from public.shifts s2 join public.staff x on x.id = s2.staff_id and x.is_doctor
                where s2.facility_id = s.facility_id and s2.shift_date = s.shift_date and s2.staff_id <> s.staff_id) as other
         from public.shifts s join public.staff st on st.id = s.staff_id and st.designation = 'medical_officer'
         join public.health_centres h on h.id = s.facility_id and h.facility_type = 'PHC' and h.code like 'PHC-SDP-%'
        where s.shift_date = $1::date order by other desc, h.code limit 1`, [tomorrow]));
    const [to] = await t.sys((q) => q.query<{ id: string }>(`select id from public.health_centres where code = 'PHC-SDP-01'`));
    if (cand.facility_id === to.id) return; // seed variant: nothing to move
    const [{ request_reassignment: rid }] = await t.as(admin, (q) => q.query<{ request_reassignment: string }>(
      `select public.request_reassignment($1, $2, $3::date, $3::date, 'Cover doctor shortage', '{}'::jsonb)`, [cand.staff_id, to.id, tomorrow]));
    if (cand.other >= 1) {
      await t.as(admin, (q) => q.query(`select public.review_reassignment($1, true, null)`, [rid]));
      const moved = await t.sys((q) => q.query<{ facility_id: string; original_facility_id: string }>(
        `select facility_id, original_facility_id from public.shifts where staff_id = $1 and shift_date = $2::date`, [cand.staff_id, tomorrow]));
      expect(moved.every((m) => m.facility_id === to.id && m.original_facility_id === cand.facility_id)).toBe(true);
    } else {
      await expect(t.as(admin, (q) => q.query(`select public.review_reassignment($1, true, null)`, [rid]))).rejects.toThrow(/DONOR_MIN_STAFFING/);
    }
  });
});
