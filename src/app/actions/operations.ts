"use server";

import { can, canWriteFacility } from "@/lib/auth/permissions";
import { withUser } from "@/lib/db";
import { todayIST } from "@/lib/dates";
import { audit } from "@/lib/actions/audit";
import { fail, ok } from "@/lib/actions/result";
import { refreshAlerts, runAction } from "@/lib/actions/run";
import {
  addShiftSchema,
  attendanceSchema,
  bedSchema,
  diagnosticSchema,
  patientStatsSchema,
  verifyAttendanceSchema,
} from "@/lib/validation/schemas";

// ---------------------------------------------------------------------------
// Patient footfall — one report per centre per day; changes need an explicit,
// reasoned correction that increments the revision number.
// ---------------------------------------------------------------------------
export async function savePatientStatsAction(input: unknown) {
  return runAction(patientStatsSchema, input, async (user, d) => {
    if (!canWriteFacility(user, d.facilityId)) return fail("FORBIDDEN");
    if (d.statDate > todayIST()) return fail("VALIDATION", { statDate: "validation.futureDate" });

    const result = await withUser(user.id, async (q) => {
      if (!d.isCorrection) {
        const rows = await q.query<{ id: string }>(
          `insert into public.patient_daily_stats
             (facility_id, stat_date, opd_visits, ipd_admissions, emergency_visits, notes, recorded_by)
           values ($1, $2::date, $3, $4, $5, $6, $7)
           on conflict (facility_id, stat_date) do nothing
           returning id`,
          [d.facilityId, d.statDate, d.opdVisits, d.ipdAdmissions, d.emergencyVisits, d.notes, user.id],
        );
        if (!rows[0]) return { duplicate: true as const };
        await audit(q, user, "footfall.reported", "patient_daily_stats", rows[0].id, d.facilityId, {
          date: d.statDate, opd: d.opdVisits, ipd: d.ipdAdmissions, emergency: d.emergencyVisits,
        });
        return { revision: 1 };
      }
      const before = await q.query<{ id: string; opd_visits: number; revision: number }>(
        `select id, opd_visits, revision from public.patient_daily_stats where facility_id = $1 and stat_date = $2::date for update`,
        [d.facilityId, d.statDate],
      );
      if (!before[0]) return { missing: true as const };
      const rows = await q.query<{ revision: number }>(
        `update public.patient_daily_stats
            set opd_visits = $3, ipd_admissions = $4, emergency_visits = $5, notes = $6,
                revision = revision + 1, correction_reason = $7, recorded_by = $8
          where facility_id = $1 and stat_date = $2::date
          returning revision`,
        [d.facilityId, d.statDate, d.opdVisits, d.ipdAdmissions, d.emergencyVisits, d.notes, d.correctionReason, user.id],
      );
      await audit(q, user, "footfall.corrected", "patient_daily_stats", before[0].id, d.facilityId, {
        date: d.statDate, from: before[0].opd_visits, to: d.opdVisits, reason: d.correctionReason, revision: rows[0].revision,
      });
      return { revision: rows[0].revision };
    });

    if ("duplicate" in result) return fail("VALIDATION", { statDate: "footfall.duplicate" });
    if ("missing" in result) return fail("VALIDATION", { isCorrection: "validation.invalid" });
    await refreshAlerts([d.facilityId]);
    return result.revision > 1 ? ok("footfall.successCorrection", { revision: result.revision }) : ok("footfall.success");
  });
}

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------
export async function saveBedStatusAction(input: unknown) {
  return runAction(bedSchema, input, async (user, d) => {
    if (!canWriteFacility(user, d.facilityId)) return fail("FORBIDDEN");
    await withUser(user.id, async (q) => {
      if (d.wardId) {
        const before = await q.query<Record<string, number>>(
          `select total_beds, occupied_beds, out_of_service_beds from public.bed_status where id = $1 and facility_id = $2 for update`,
          [d.wardId, d.facilityId],
        );
        if (!before[0]) throw new Error("FORBIDDEN");
        await q.query(
          `update public.bed_status set ward = $3, total_beds = $4, occupied_beds = $5, out_of_service_beds = $6,
                  updated_by = $7, verified_at = now()
            where id = $1 and facility_id = $2`,
          [d.wardId, d.facilityId, d.ward, d.totalBeds, d.occupiedBeds, d.outOfServiceBeds, user.id],
        );
        await audit(q, user, "beds.updated", "bed_status", d.wardId, d.facilityId, {
          ward: d.ward, before: before[0], after: { total: d.totalBeds, occupied: d.occupiedBeds, oos: d.outOfServiceBeds },
        });
      } else {
        const rows = await q.query<{ id: string }>(
          `insert into public.bed_status (facility_id, ward, total_beds, occupied_beds, out_of_service_beds, updated_by, verified_at)
           values ($1, $2, $3, $4, $5, $6, now()) returning id`,
          [d.facilityId, d.ward, d.totalBeds, d.occupiedBeds, d.outOfServiceBeds, user.id],
        );
        await audit(q, user, "beds.ward_added", "bed_status", rows[0].id, d.facilityId, { ward: d.ward, total: d.totalBeds });
      }
    });
    await refreshAlerts([d.facilityId]);
    return ok("beds.success");
  });
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------
export async function recordAttendanceAction(input: unknown) {
  return runAction(attendanceSchema, input, async (user, d) => {
    const facilityId = await withUser(user.id, async (q) => {
      const shift = await q.query<{ facility_id: string; shift_date: string }>(
        `select facility_id, shift_date from public.shifts where id = $1`,
        [d.shiftId],
      );
      if (!shift[0]) throw new Error("FORBIDDEN");
      if (shift[0].shift_date > todayIST()) throw new Error("INVALID_INPUT_FUTURE");
      if (!canWriteFacility(user, shift[0].facility_id)) throw new Error("FORBIDDEN");
      await q.query(
        `insert into public.attendance (shift_id, facility_id, status, notes, recorded_by, recorded_at, verification_status)
         values ($1, $2, $3, $4, $5, now(), 'unverified')
         on conflict (shift_id) do update
           set status = excluded.status, notes = excluded.notes, recorded_by = excluded.recorded_by,
               recorded_at = now(), verification_status = 'unverified'`,
        [d.shiftId, shift[0].facility_id, d.status, d.notes, user.id],
      );
      await audit(q, user, "attendance.recorded", "shift", d.shiftId, shift[0].facility_id, { status: d.status });
      return shift[0].facility_id;
    }).catch((e: Error) => {
      if (e.message === "INVALID_INPUT_FUTURE") return "FUTURE" as const;
      throw e;
    });
    if (facilityId === "FUTURE") return fail("VALIDATION", { shiftId: "validation.futureDate" });
    await refreshAlerts([facilityId]);
    return ok("attendance.success");
  });
}

export async function verifyAttendanceAction(input: unknown) {
  return runAction(verifyAttendanceSchema, input, async (user, d) => {
    if (!can(user, "attendance:verify")) return fail("FORBIDDEN");
    const facilityId = await withUser(user.id, async (q) => {
      const rows = await q.query<{ facility_id: string }>(
        `update public.attendance set verification_status = 'verified' where id = $1 returning facility_id`,
        [d.attendanceId],
      );
      if (!rows[0]) throw new Error("FORBIDDEN");
      await audit(q, user, "attendance.verified", "attendance", d.attendanceId, rows[0].facility_id);
      return rows[0].facility_id;
    });
    await refreshAlerts([facilityId]);
    return ok("attendance.verifiedSuccess");
  });
}

export async function addShiftAction(input: unknown) {
  return runAction(addShiftSchema, input, async (user, d) => {
    await withUser(user.id, async (q) => {
      const staff = await q.query<{ facility_id: string }>(`select facility_id from public.staff where id = $1 and is_active`, [d.staffId]);
      if (!staff[0] || !canWriteFacility(user, staff[0].facility_id)) throw new Error("FORBIDDEN");
      const rows = await q.query<{ id: string }>(
        `insert into public.shifts (facility_id, staff_id, shift_date, shift_type, created_by) values ($1, $2, $3::date, $4, $5) returning id`,
        [staff[0].facility_id, d.staffId, d.shiftDate, d.shiftType, user.id],
      );
      await audit(q, user, "roster.shift_added", "shift", rows[0].id, staff[0].facility_id, { date: d.shiftDate, type: d.shiftType });
    });
    return ok("attendance.shiftAdded");
  });
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
export async function updateDiagnosticAction(input: unknown) {
  return runAction(diagnosticSchema, input, async (user, d) => {
    const facilityId = await withUser(user.id, async (q) => {
      const before = await q.query<{ facility_id: string; status: string }>(
        `select facility_id, status from public.diagnostic_services where id = $1 for update`,
        [d.serviceId],
      );
      if (!before[0] || !canWriteFacility(user, before[0].facility_id)) throw new Error("FORBIDDEN");
      const available = d.status === "available";
      await q.query(
        `update public.diagnostic_services
            set status = $2, restriction_note = $3, unavailability_reason = $4, equipment_issue = $5,
                required_supplies = $6, estimated_restoration_date = $7::date, last_verified_at = now(), updated_by = $8
          where id = $1`,
        [
          d.serviceId, d.status, available ? null : d.restrictionNote, available ? null : d.unavailabilityReason,
          available ? null : d.equipmentIssue, available ? null : d.requiredSupplies,
          available ? null : d.estimatedRestorationDate, user.id,
        ],
      );
      await audit(q, user, "diagnostics.updated", "diagnostic_service", d.serviceId, before[0].facility_id, {
        from: before[0].status, to: d.status, reason: d.unavailabilityReason ?? d.restrictionNote,
      });
      return before[0].facility_id;
    });
    await refreshAlerts([facilityId]);
    return ok("diagnostics.success");
  });
}
