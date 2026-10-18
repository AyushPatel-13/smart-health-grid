import { ATTENDANCE_RULES as A, WORKFORCE_RULES as W } from "../config/rules";

// Mobile attendance verification rules (pure, unit-tested).
// Any failed check routes the record to MANUAL REVIEW — it never marks a
// doctor absent and is never treated as misconduct.

export type CheckReason =
  | "outside_geofence"
  | "low_accuracy"
  | "stale_location"
  | "future_time"
  | "identity_failed"
  | "no_location"
  | "late"
  | "short_duty"
  | "simulated_location_demo";

/** Informational reasons are recorded but do not by themselves force review. */
const INFORMATIONAL: CheckReason[] = ["late", "simulated_location_demo"];

export interface CheckInput {
  event: "check_in" | "check_out";
  distanceM: number | null; // null when no location could be obtained
  accuracyM: number | null;
  locationAgeS: number | null; // server time − device position time
  radiusM: number;
  identityOk: boolean;
  simulated: boolean;
  shiftType: string;
  shiftDate: string; // YYYY-MM-DD (IST)
  now: Date;
  checkInAt?: Date | null; // for check-out duty duration
}

export interface CheckResult {
  result: "accepted" | "needs_review";
  reasons: CheckReason[];
  dutyMinutes: number | null;
}

/** IST instant for an hour offset (may exceed 24 for overnight shifts). */
function shiftInstant(date: string, hour: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0) - 330 * 60_000 + hour * 3_600_000);
}

export function evaluateAttendance(c: CheckInput): CheckResult {
  const reasons: CheckReason[] = [];
  if (!c.identityOk) reasons.push("identity_failed");
  if (c.distanceM === null || c.accuracyM === null || c.locationAgeS === null) {
    reasons.push("no_location");
  } else {
    if (c.accuracyM > A.maxAccuracyM) reasons.push("low_accuracy");
    if (c.locationAgeS > A.maxLocationAgeS) reasons.push("stale_location");
    if (c.locationAgeS < -60) reasons.push("future_time");
    // Inside if the position (allowing for its reported accuracy, capped) can be within the fence.
    if (c.distanceM - Math.min(c.accuracyM, 50) > c.radiusM) reasons.push("outside_geofence");
  }
  if (c.simulated) reasons.push("simulated_location_demo");

  const [startH, endH] = W.shiftHours[c.shiftType] ?? [8, 14];
  let dutyMinutes: number | null = null;
  if (c.event === "check_in") {
    if (c.now.getTime() > shiftInstant(c.shiftDate, startH).getTime() + W.lateGraceMinutes * 60_000) reasons.push("late");
  } else if (c.checkInAt) {
    dutyMinutes = Math.max(0, Math.round((c.now.getTime() - c.checkInAt.getTime()) / 60_000));
    const scheduled = (endH - startH) * 60;
    if (dutyMinutes < scheduled * A.minDutyShare) reasons.push("short_duty");
  }
  const blocking = reasons.filter((r) => !INFORMATIONAL.includes(r));
  return { result: blocking.length ? "needs_review" : "accepted", reasons, dutyMinutes };
}
