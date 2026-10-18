"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { runDueAllocations } from "@/lib/allocation/runner";
import { recommendFacilities } from "@/lib/allocation/recommend";
import { cancelAppointment, registerPatient, submitRequest, verifyPatientAccess } from "@/lib/allocation/service";
import { clearPatientSession, getPatientSession, setPatientSession } from "@/lib/auth/patient-session";
import { can, canWriteFacility } from "@/lib/auth/permissions";
import { getCurrentUser } from "@/lib/auth/user";
import { isValidDay } from "@/lib/dates";
import { isDemoMode } from "@/lib/env";
import { toDbError, withSystem, withUser } from "@/lib/db";
import { audit } from "@/lib/actions/audit";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import { runAction } from "@/lib/actions/run";

// --- simple per-instance throttle for public endpoints ----------------------
const hits = new Map<string, number[]>();
async function throttle(bucket: string, limit: number, windowMs: number): Promise<boolean> {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > limit;
}

const PUBLIC_ERRORS = new Set(["CONSENT_REQUIRED", "SLOT_TOO_SOON", "PREFERRED_NOT_ELIGIBLE", "PATIENT_NOT_FOUND", "SERVICE_NOT_FOUND", "APPOINTMENT_NOT_FOUND", "APPOINTMENT_NOT_ACTIVE"]);
function mapError(err: unknown): ActionResult {
  const msg = err instanceof Error ? err.message : String(err);
  if (PUBLIC_ERRORS.has(msg)) return fail(msg);
  const e = toDbError(err);
  if (e.code === "UNKNOWN") console.error("[shg] patient action failed:", msg);
  return fail(e.code);
}

const coord = z.number().min(-90).max(180);
const day = z.string().refine(isValidDay, "validation.invalidDate");
const time = z.string().regex(/^\d{2}:\d{2}$/, "validation.invalid");

// ---------------------------------------------------------------------------
// Public: recommendations
// ---------------------------------------------------------------------------
const recommendSchema = z.object({ lat: coord, lon: coord, serviceId: z.guid(), date: day, time });

export async function recommendAction(input: unknown) {
  const p = recommendSchema.safeParse(input);
  if (!p.success) return { ok: false as const, error: "VALIDATION" };
  if (await throttle("recommend", 60, 60_000)) return { ok: false as const, error: "patient.rateLimited" };
  const data = await withSystem((q) => recommendFacilities(q, p.data));
  return { ok: true as const, data };
}

// ---------------------------------------------------------------------------
// Public / assisted: register + request
// ---------------------------------------------------------------------------
const registerSchema = z.object({
  fullName: z.string().trim().min(2, "validation.required").max(120, "validation.tooLong"),
  birthYear: z.number({ error: "validation.invalid" }).int().min(1900, "validation.invalid").max(new Date().getFullYear(), "validation.invalid").nullable(),
  sex: z.enum(["female", "male", "other", "undisclosed"]),
  phone: z.union([z.string().regex(/^[6-9][0-9]{9}$/, "validation.invalid"), z.literal(""), z.null()]).transform((v) => v || null),
  addressText: z.string().trim().max(200).nullable(),
  lat: coord,
  lon: coord,
  locationSource: z.enum(["device", "locality", "staff"]),
  preferredLanguage: z.enum(["en", "hi"]),
  consentData: z.literal(true, { error: "patient.consentRequired" }),
  consentLocation: z.literal(true, { error: "patient.consentRequired" }),
  consentSms: z.boolean(),
  serviceId: z.guid(),
  date: day,
  time,
  preferredFacilityId: z.union([z.guid(), z.literal(""), z.null()]).transform((v) => v || null),
  idempotencyKey: z.string().min(8).max(80),
});

export async function registerAction(input: unknown): Promise<ActionResult<{ patientCode: string; pin: string; status: string; cutoff: string | null; emergency: { name: string; km: number } | null }>> {
  const p = registerSchema.safeParse(input);
  if (!p.success) {
    const fe: Record<string, string> = {};
    for (const i of p.error.issues) fe[i.path.join(".")] ??= i.message.includes(".") ? i.message : "validation.invalid";
    return fail("VALIDATION", fe);
  }
  const d = p.data;
  const staff = await getCurrentUser();
  if (!staff && (await throttle("register", 10, 60 * 60_000))) return fail("patient.rateLimited");
  try {
    const result = await withSystem(async (q) => {
      const reg = await registerPatient(q, {
        fullName: d.fullName, birthYear: d.birthYear, sex: d.sex, phone: d.phone, addressText: d.addressText,
        latitude: d.lat, longitude: d.lon, locationSource: staff ? "staff" : d.locationSource, preferredLanguage: d.preferredLanguage,
        consentData: d.consentData, consentLocation: d.consentLocation, consentSms: d.consentSms,
        registeredVia: staff ? "assisted" : "self", registeredBy: staff?.id ?? null, isDemo: isDemoMode(),
        registrationKey: d.idempotencyKey,
      });
      const req = await submitRequest(q, {
        patientId: reg.patientId, serviceId: d.serviceId, slotDate: d.date, startTime: `${d.time}:00`,
        preferredFacilityId: d.preferredFacilityId, idempotencyKey: d.idempotencyKey,
      });
      await q.query(
        `insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, details) values ($1, $2, 'patient.registered', 'patient', $3, $4::jsonb)`,
        [staff?.id ?? null, staff?.role ?? "patient", reg.patientId, JSON.stringify({ via: staff ? "assisted" : "self", request: req.request_code })],
      );
      return { reg, req };
    });
    if (!staff) await setPatientSession(result.reg.patientId);
    const em = "emergency" in result.req ? (result.req.emergency as { name: string; km: number } | null) : null;
    return ok(undefined, undefined, {
      patientCode: result.reg.patientCode,
      pin: result.reg.pin,
      status: result.req.status,
      cutoff: "cutoff" in result.req ? (result.req.cutoff as string) : null,
      emergency: em ? { name: em.name, km: em.km } : null,
    });
  } catch (err) {
    return mapError(err) as ActionResult<never>;
  }
}

// ---------------------------------------------------------------------------
// Patient self-service (Patient ID + PIN → signed cookie)
// ---------------------------------------------------------------------------
const loginSchema = z.object({ patientCode: z.string().trim().min(6).max(20), pin: z.string().regex(/^\d{6}$/) });

export async function patientLoginAction(input: unknown): Promise<ActionResult> {
  const p = loginSchema.safeParse(input);
  if (!p.success) return fail("patient.invalidAccess");
  if (await throttle("patient-login", 10, 10 * 60_000)) return fail("patient.rateLimited");
  const pid = await withSystem((q) => verifyPatientAccess(q, p.data.patientCode, p.data.pin));
  if (!pid) return fail("patient.invalidAccess");
  await setPatientSession(pid);
  return ok();
}

export async function patientLogoutAction() {
  await clearPatientSession();
}

const cancelSchema = z.object({ appointmentId: z.guid(), reason: z.string().trim().min(3, "validation.reasonMin").max(200) });

export async function patientCancelAction(input: unknown): Promise<ActionResult> {
  const pid = await getPatientSession();
  if (!pid) return fail("patient.invalidAccess");
  const p = cancelSchema.safeParse(input);
  if (!p.success) return fail("VALIDATION", { reason: "validation.reasonMin" });
  try {
    await withSystem(async (q) => {
      const own = await q.query(`select 1 from public.appointments where id = $1 and patient_id = $2`, [p.data.appointmentId, pid]);
      if (!own.length) throw new Error("APPOINTMENT_NOT_FOUND");
      await cancelAppointment(q, p.data.appointmentId, `Patient: ${p.data.reason}`, null);
    });
    return ok("patient.cancelled");
  } catch (err) {
    return mapError(err);
  }
}

const newRequestSchema = z.object({
  serviceId: z.guid(),
  date: day,
  time,
  preferredFacilityId: z.union([z.guid(), z.literal(""), z.null()]).transform((v) => v || null),
  idempotencyKey: z.string().min(8).max(80),
});

export async function patientNewRequestAction(input: unknown): Promise<ActionResult> {
  const pid = await getPatientSession();
  if (!pid) return fail("patient.invalidAccess");
  const p = newRequestSchema.safeParse(input);
  if (!p.success) return fail("VALIDATION");
  try {
    await withSystem((q) =>
      submitRequest(q, {
        patientId: pid, serviceId: p.data.serviceId, slotDate: p.data.date, startTime: `${p.data.time}:00`,
        preferredFacilityId: p.data.preferredFacilityId, idempotencyKey: p.data.idempotencyKey,
      }),
    );
    return ok("patient.requestSubmitted");
  } catch (err) {
    return mapError(err);
  }
}

// ---------------------------------------------------------------------------
// Staff: check-in and queue
// ---------------------------------------------------------------------------
const checkInSchema = z.object({
  facilityId: z.guid(),
  patientCode: z.string().trim().min(6).max(20),
  appointmentId: z.union([z.guid(), z.null()]).optional(),
});

export async function checkInAction(input: unknown) {
  return runAction(checkInSchema, input, async (user, d) => {
    if (!canWriteFacility(user, d.facilityId)) return fail("FORBIDDEN");
    const [row] = await withUser(user.id, (q) =>
      q.query<{ queue_number: number; duplicate: boolean }>(`select * from public.check_in_patient($1, $2, $3, null)`, [
        d.facilityId, d.patientCode, d.appointmentId ?? null,
      ]),
    );
    return ok(row.duplicate ? "queue.alreadyCheckedIn" : "queue.checkedIn", { n: row.queue_number });
  });
}

const visitSchema = z.object({
  visitId: z.guid(),
  status: z.enum(["in_consultation", "completed", "cancelled", "left_without_care"]),
  reason: z.string().trim().max(200).optional().nullable(),
});

export async function visitStatusAction(input: unknown) {
  return runAction(visitSchema, input, async (user, d) => {
    if (!can(user, "operations:write")) return fail("FORBIDDEN");
    await withUser(user.id, (q) => q.query(`select public.update_visit_status($1, $2, $3)`, [d.visitId, d.status, d.reason ?? null]));
    return ok("common.saved");
  });
}

const staffCancelSchema = z.object({ appointmentId: z.guid(), reason: z.string().trim().min(5, "validation.reasonMin").max(200) });

export async function staffCancelAppointmentAction(input: unknown) {
  return runAction(staffCancelSchema, input, async (user, d) => {
    const [appt] = await withUser(user.id, (q) => q.query<{ facility_id: string }>(`select facility_id from public.appointments where id = $1`, [d.appointmentId]));
    if (!appt || !canWriteFacility(user, appt.facility_id)) return fail("FORBIDDEN");
    await withSystem((q) => cancelAppointment(q, d.appointmentId, `Staff: ${d.reason}`, user.id));
    return ok("patient.cancelled");
  });
}

// ---------------------------------------------------------------------------
// Admin: allocation batches
// ---------------------------------------------------------------------------
export async function closeWindowNowAction(input: unknown) {
  return runAction(z.object({ windowId: z.guid() }), input, async (user, d) => {
    if (!can(user, "admin:manage")) return fail("FORBIDDEN");
    await withSystem((q) =>
      q.query(
        `update public.allocation_windows set cutoff_at = greatest(now(), window_start + interval '1 second') where id = $1 and status = 'open'`,
        [d.windowId],
      ),
    );
    await withUser(user.id, (q) => audit(q, user, "allocation.window_closed_early", "allocation_window", d.windowId, null));
    // Ensure the new cutoff has passed before processing.
    await new Promise((r) => setTimeout(r, 1100));
    const results = await runDueAllocations("admin");
    return ok("allocation.processed", { n: results.filter((r) => r.status === "completed").length });
  });
}

export async function runDueAllocationsAction() {
  return runAction(z.object({}), {}, async (user) => {
    if (!can(user, "admin:manage")) return fail("FORBIDDEN");
    const results = await runDueAllocations("admin");
    return ok("allocation.processed", { n: results.filter((r) => r.status === "completed").length });
  });
}
