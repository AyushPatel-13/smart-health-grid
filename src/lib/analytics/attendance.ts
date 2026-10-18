// Attendance classification. Missing data is NEVER treated as an absence:
// a past shift with no record is "incomplete" and needs administrative review.

export type AttendanceClass =
  | "present"
  | "absent_verified"
  | "approved_leave"
  | "unverified"
  | "incomplete"
  | "pending"
  | "scheduled";

export interface ShiftRecord {
  shiftId: string;
  staffId: string;
  isDoctor: boolean;
  shiftDate: string;
  shiftType: string;
  status: "present" | "absent" | "approved_leave" | null;
  verification: "verified" | "unverified" | null;
}

export function classifyShift(s: ShiftRecord, today: string): AttendanceClass {
  if (s.shiftDate > today) return "scheduled";
  if (!s.status) return s.shiftDate === today ? "pending" : "incomplete";
  if (s.status === "approved_leave") return "approved_leave";
  if (s.verification !== "verified") return "unverified";
  return s.status === "present" ? "present" : "absent_verified";
}

export interface AttendanceSummary {
  counts: Record<AttendanceClass, number>;
  pastShifts: number;
  doctorShifts: number;
  doctorPresent: number;
  doctorLeave: number;
  /** Doctor shifts with a present record (verified or not) / doctor shifts not on approved leave */
  doctorCoverage: number | null;
  /** Past days on which doctors were rostered but none was recorded present */
  daysWithoutDoctor: string[];
  unverifiedOrIncompleteShare: number;
  needsReview: boolean;
  reviewReasons: { key: string; params?: Record<string, string | number> }[];
}

export function summarizeAttendance(records: ShiftRecord[], today: string, reviewShare: number): AttendanceSummary {
  const counts: Record<AttendanceClass, number> = {
    present: 0,
    absent_verified: 0,
    approved_leave: 0,
    unverified: 0,
    incomplete: 0,
    pending: 0,
    scheduled: 0,
  };
  const doctorDays = new Map<string, { rostered: number; present: number }>();
  let doctorShifts = 0;
  let doctorPresent = 0;
  let doctorLeave = 0;

  for (const r of records) {
    const c = classifyShift(r, today);
    counts[c]++;
    if (r.isDoctor && r.shiftDate <= today) {
      doctorShifts++;
      if (r.status === "present") doctorPresent++;
      if (r.status === "approved_leave") doctorLeave++;
      if (r.shiftDate < today) {
        const d = doctorDays.get(r.shiftDate) ?? { rostered: 0, present: 0 };
        d.rostered++;
        if (r.status === "present") d.present++;
        doctorDays.set(r.shiftDate, d);
      }
    }
  }

  const pastShifts =
    counts.present + counts.absent_verified + counts.approved_leave + counts.unverified + counts.incomplete;
  const share = pastShifts ? (counts.unverified + counts.incomplete) / pastShifts : 0;
  const coverageBase = doctorShifts - doctorLeave;
  const doctorCoverage = coverageBase > 0 ? doctorPresent / coverageBase : doctorShifts > 0 ? 0 : null;
  const daysWithoutDoctor = [...doctorDays.entries()]
    .filter(([, v]) => v.rostered > 0 && v.present === 0)
    .map(([d]) => d)
    .sort();

  const reviewReasons: AttendanceSummary["reviewReasons"] = [];
  if (daysWithoutDoctor.length > 0) {
    reviewReasons.push({ key: "attendance.reason.daysWithoutDoctor", params: { days: daysWithoutDoctor.length } });
  }
  if (share >= reviewShare) {
    reviewReasons.push({ key: "attendance.reason.unverifiedShare", params: { pct: Math.round(share * 100) } });
  }
  if (counts.incomplete > 0) {
    reviewReasons.push({ key: "attendance.reason.incomplete", params: { count: counts.incomplete } });
  }

  return {
    counts,
    pastShifts,
    doctorShifts,
    doctorPresent,
    doctorLeave,
    doctorCoverage: doctorCoverage === null ? null : Math.round(doctorCoverage * 100) / 100,
    daysWithoutDoctor,
    unverifiedOrIncompleteShare: Math.round(share * 100) / 100,
    needsReview: daysWithoutDoctor.length > 0 || share >= reviewShare,
    reviewReasons,
  };
}
