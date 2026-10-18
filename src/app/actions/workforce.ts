"use server";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { haversineKm } from "@/lib/analytics/redistribution";
import { verifyPassword } from "@/lib/auth/password";
import { can } from "@/lib/auth/permissions";
import { ATTENDANCE_RULES } from "@/lib/config/rules";
import { getDataMode, isDemoMode } from "@/lib/env";
import { withSystem, withUser } from "@/lib/db";
import { isValidDay, todayIST } from "@/lib/dates";
import { evaluateAttendance } from "@/lib/workforce/geofence";
import { fail, ok } from "@/lib/actions/result";
import { refreshAlerts, runAction } from "@/lib/actions/run";

const mobileSchema = z.object({
  shiftId: z.guid(),
  event: z.enum(["check_in", "check_out"]),
  lat: z.number().min(-90).max(90).nullable(),
  lon: z.number().min(-180).max(180).nullable(),
  accuracy: z.number().min(0).max(100_000).nullable(),
  positionTime: z.number().nullable(), // epoch ms from the device
  nonce: z.string().min(8).max(80),
  password: z.string().min(1).max(200),
  simulate: z.enum(["at", "away"]).nullable(),
});

/** Step-up identity confirmation: re-enter the account password (no biometrics). */
async function confirmIdentity(userId: string, email: string, password: string): Promise<boolean> {
  if (getDataMode() === "supabase") {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    return !error && data.user?.id === userId;
  }
  const [row] = await withSystem((q) => q.query<{ encrypted_password: string | null }>(`select encrypted_password from auth.users where id = $1`, [userId]));
  return verifyPassword(password, row?.encrypted_password ?? "scrypt$00$00");
}

export async function mobileAttendanceAction(input: unknown) {
  return runAction(mobileSchema, input, async (user, d) => {
    if (d.simulate && !isDemoMode()) return fail("FORBIDDEN"); // simulation exists only in the demo
    const [ctx] = await withUser(user.id, (q) =>
      q.query<{ shift_type: string; shift_date: string; lat: number | null; lon: number | null; radius: number; check_in_at: string | null }>(
        `select s.shift_type, s.shift_date, h.latitude as lat, h.longitude as lon, h.geofence_radius_m as radius, a.check_in_at
           from public.shifts s join public.staff st on st.id = s.staff_id and st.profile_id = $2
           join public.health_centres h on h.id = s.facility_id
           left join public.attendance a on a.shift_id = s.id
          where s.id = $1`,
        [d.shiftId, user.id],
      ),
    );
    if (!ctx) return fail("FORBIDDEN");
    const identityOk = await confirmIdentity(user.id, user.email, d.password);

    // Location: only the distance to the facility and the accuracy are kept.
    let lat = d.lat;
    let lon = d.lon;
    let accuracy = d.accuracy;
    let positionTime = d.positionTime;
    if (d.simulate && ctx.lat != null && ctx.lon != null) {
      const offsetKm = d.simulate === "at" ? 0.03 : 1.2;
      lat = ctx.lat + offsetKm / 110.574;
      lon = ctx.lon;
      accuracy = 15;
      positionTime = Date.now();
    }
    const now = new Date();
    const distanceM =
      lat != null && lon != null && ctx.lat != null && ctx.lon != null
        ? Math.round(haversineKm({ lat, lon }, { lat: ctx.lat, lon: ctx.lon }) * 1000)
        : null;
    const ageS = positionTime ? Math.round((now.getTime() - positionTime) / 1000) : null;
    const check = evaluateAttendance({
      event: d.event,
      distanceM,
      accuracyM: accuracy === null ? null : Math.round(accuracy),
      locationAgeS: ageS,
      radiusM: ctx.radius ?? ATTENDANCE_RULES.defaultGeofenceM,
      identityOk,
      simulated: !!d.simulate,
      shiftType: ctx.shift_type,
      shiftDate: ctx.shift_date,
      now,
      checkInAt: ctx.check_in_at ? new Date(ctx.check_in_at) : null,
    });
    const [{ r }] = await withUser(user.id, (q) =>
      q.query<{ r: string }>(
        `select public.record_mobile_attendance($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12) as r`,
        [
          d.shiftId, d.event, d.nonce, check.result, JSON.stringify(check.reasons), distanceM, accuracy === null ? null : Math.round(accuracy),
          ageS, positionTime ? new Date(positionTime).toISOString() : null, identityOk ? "password_step_up" : "password_step_up_failed",
          !!d.simulate, check.dutyMinutes,
        ],
      ),
    );
    await refreshAlerts(["all"]);
    const key = r.startsWith("duplicate:") ? "duplicate" : r;
    return ok(`myAttendance.result.${key}`, undefined, { result: key, reasons: check.reasons, distanceM, accuracy });
  });
}

export async function reviewAttendanceAction(input: unknown) {
  return runAction(
    z.object({ attendanceId: z.guid(), verify: z.boolean(), notes: z.string().trim().min(5, "validation.reasonMin").max(300) }),
    input,
    async (user, d) => {
      if (!can(user, "attendance:verify")) return fail("FORBIDDEN");
      await withUser(user.id, (q) => q.query(`select public.review_attendance($1, $2, $3)`, [d.attendanceId, d.verify, d.notes]));
      await refreshAlerts(["all"]);
      return ok("workforce.reviewed");
    },
  );
}

export async function requestReassignmentAction(input: unknown) {
  return runAction(
    z.object({
      staffId: z.guid(),
      toFacilityId: z.guid(),
      date: z.string().refine(isValidDay, "validation.invalidDate"),
      reason: z.string().trim().min(5, "validation.reasonMin").max(300),
      recommendation: z.record(z.string(), z.unknown()).optional(),
    }),
    input,
    async (user, d) => {
      if (!can(user, "admin:manage")) return fail("FORBIDDEN");
      if (d.date < todayIST()) return fail("VALIDATION", { date: "validation.invalidDate" });
      await withUser(user.id, (q) =>
        q.query(`select public.request_reassignment($1, $2, $3::date, $3::date, $4, $5::jsonb)`, [
          d.staffId, d.toFacilityId, d.date, d.reason, JSON.stringify(d.recommendation ?? {}),
        ]),
      );
      return ok("workforce.requested");
    },
  );
}

export async function reviewReassignmentAction(input: unknown) {
  return runAction(
    z.object({ id: z.guid(), approve: z.boolean(), notes: z.string().trim().max(300).optional().nullable() }),
    input,
    async (user, d) => {
      if (!can(user, "admin:manage")) return fail("FORBIDDEN");
      await withUser(user.id, (q) => q.query(`select public.review_reassignment($1, $2, $3)`, [d.id, d.approve, d.notes ?? null]));
      await refreshAlerts(["all"]);
      return ok(d.approve ? "workforce.approvedMsg" : "common.saved");
    },
  );
}
