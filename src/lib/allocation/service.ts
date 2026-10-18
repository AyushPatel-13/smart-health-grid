import { createHmac, randomBytes, randomInt } from "node:crypto";
import { sessionSecret } from "../env";
import { ALLOCATION_RULES } from "../config/rules";
import { haversineKm } from "../analytics/redistribution";
import { hashPassword, verifyPassword } from "../auth/password";
import { addDays, todayIST } from "../dates";
import type { Queryable } from "../db/types";
import { allocate, tieKey, type AllocSlot } from "./engine";

// Server-side allocation service. Every function receives a Queryable bound to
// one transaction, so each operation commits atomically.

const IST_OFFSET_MIN = 330;

/** Window boundaries aligned to the configured duration in IST. */
export function windowBounds(now: Date, minutes = ALLOCATION_RULES.windowMinutes) {
  const ms = minutes * 60_000;
  const shifted = now.getTime() + IST_OFFSET_MIN * 60_000;
  const start = Math.floor(shifted / ms) * ms - IST_OFFSET_MIN * 60_000;
  return { start: new Date(start), cutoff: new Date(start + ms) };
}

/** Instant at which a slot (IST date + HH:MM[:SS]) starts. */
export function slotInstant(date: string, time: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - IST_OFFSET_MIN * 60_000);
}

export interface WindowRow {
  id: string;
  window_start: string;
  cutoff_at: string;
  status: "open" | "processing" | "completed" | "failed";
  attempts: number;
  last_error: string | null;
  summary: Record<string, unknown>;
  processed_at: string | null;
  started_at: string | null;
}

/** Return the currently open registration window, creating it if needed. */
export async function ensureOpenWindow(q: Queryable, now = new Date()): Promise<WindowRow> {
  const open = await q.query<WindowRow>(
    `select * from public.allocation_windows where status = 'open' and window_start <= $1 and cutoff_at > $1
      order by window_start desc limit 1`,
    [now.toISOString()],
  );
  if (open[0]) return open[0];
  const { start, cutoff } = windowBounds(now);
  // If the aligned window was closed early by an administrator, open a new one now.
  const aligned = await q.query<{ id: string }>(`select id from public.allocation_windows where window_start = $1`, [start.toISOString()]);
  const begin = aligned[0] ? new Date(Math.floor(now.getTime() / 1000) * 1000) : start;
  await q.query(
    `insert into public.allocation_windows (window_start, cutoff_at, status) values ($1, $2, 'open')
     on conflict (window_start) do nothing`,
    [begin.toISOString(), cutoff.toISOString()],
  );
  const rows = await q.query<WindowRow>(`select * from public.allocation_windows where window_start = $1`, [begin.toISOString()]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------
interface SlotCandidate extends AllocSlot {
  capacity: number;
  allocated: number;
  facilityName: string;
}

/**
 * Slots for a service/date/time at ELIGIBLE centres: offers the service,
 * not non-operational, meets the minimum facility level, and the service's
 * required diagnostic test is not unavailable. Rows are locked for update.
 */
async function eligibleSlots(q: Queryable, serviceId: string, date: string, time: string, lock: boolean): Promise<SlotCandidate[]> {
  return q.query<SlotCandidate>(
    `select s.id as "slotId", s.facility_id as "facilityId", h.latitude as lat, h.longitude as lon,
            (s.capacity - s.allocated) as remaining, s.capacity, s.allocated, h.name as "facilityName"
       from public.appointment_slots s
       join public.health_centres h on h.id = s.facility_id
       join public.services sv on sv.id = s.service_id
       join public.facility_services fs on fs.facility_id = s.facility_id and fs.service_id = s.service_id and fs.is_active
      where s.service_id = $1 and s.slot_date = $2::date and s.start_time = $3::time and s.is_active
        and h.operational_status <> 'non_operational'
        and h.latitude is not null and h.longitude is not null
        and (sv.min_facility_type = 'PHC' or h.facility_type = 'CHC')
        and (sv.required_test_id is null or not exists (
              select 1 from public.diagnostic_services ds
               where ds.facility_id = h.id and ds.test_id = sv.required_test_id and ds.status = 'unavailable')
             and exists (select 1 from public.diagnostic_services ds2 where ds2.facility_id = h.id and ds2.test_id = sv.required_test_id))
      order by s.id
      ${lock ? "for update of s" : ""}`,
    [serviceId, date, time],
  );
}

async function alternativesFor(q: Queryable, req: { service_id: string; slot_date: string; start_time: string; latitude: number; longitude: number }) {
  const rows = await q.query<{ facility: string; facility_id: string; slot_date: string; start_time: string; lat: number; lon: number; remaining: number }>(
    `select h.name as facility, h.id as facility_id, s.slot_date, s.start_time::text as start_time, h.latitude as lat, h.longitude as lon,
            s.capacity - s.allocated as remaining
       from public.appointment_slots s
       join public.health_centres h on h.id = s.facility_id
       join public.facility_services fs on fs.facility_id = s.facility_id and fs.service_id = s.service_id and fs.is_active
      where s.service_id = $1 and s.is_active and s.allocated < s.capacity and h.operational_status <> 'non_operational'
        and (s.slot_date, s.start_time) > ($2::date, $3::time) and s.slot_date <= $2::date + $4::int`,
    [req.service_id, req.slot_date, req.start_time, ALLOCATION_RULES.alternativesDays],
  );
  return rows
    .map((r) => ({ ...r, km: Math.round(haversineKm({ lat: req.latitude, lon: req.longitude }, { lat: r.lat, lon: r.lon }) * 100) / 100 }))
    .filter((r) => r.km <= ALLOCATION_RULES.maxDistanceKm)
    .sort((a, b) => a.slot_date.localeCompare(b.slot_date) || a.start_time.localeCompare(b.start_time) || a.km - b.km)
    .slice(0, 3)
    .map((r) => ({ facility: r.facility, facilityId: r.facility_id, date: r.slot_date, time: r.start_time.slice(0, 5), km: r.km }));
}

function code(prefix: string) {
  return `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Core: allocate a set of requests competing for the same service/date/time
// ---------------------------------------------------------------------------
interface PendingRequest {
  id: string;
  patient_id: string;
  service_id: string;
  slot_date: string;
  start_time: string;
  latitude: number;
  longitude: number;
  preferred_facility_id: string | null;
  tie_key: string;
}

async function allocateGroup(q: Queryable, windowId: string | null, group: PendingRequest[], outcomeLabel: "allocated" | "reallocated") {
  const { service_id, slot_date, start_time } = group[0];
  const slots = await eligibleSlots(q, service_id, slot_date, start_time, true);
  const result = allocate(
    group.map((r) => ({ id: r.id, lat: r.latitude, lon: r.longitude, preferredFacilityId: r.preferred_facility_id, tieKey: r.tie_key })),
    slots,
    { maxDistanceKm: ALLOCATION_RULES.maxDistanceKm },
  );
  const reqById = new Map(group.map((r) => [r.id, r]));
  const slotById = new Map(slots.map((s) => [s.slotId, s]));
  let allocated = 0;
  let firstChoice = 0;

  for (const a of result.assignments) {
    const r = reqById.get(a.requestId)!;
    // Atomic seat reservation; the CHECK (allocated <= capacity) is the backstop.
    const seat = await q.query<{ id: string }>(
      `update public.appointment_slots set allocated = allocated + 1 where id = $1 and allocated < capacity returning id`,
      [a.slotId],
    );
    if (!seat[0]) throw new Error(`Capacity changed concurrently for slot ${a.slotId}`);
    const appt = await q.query<{ id: string }>(
      `insert into public.appointments (appointment_code, request_id, patient_id, slot_id, facility_id, service_id, slot_date, start_time,
                                        distance_km, preference_rank, rank_at_facility, window_id)
       values ($1, $2, $3, $4, $5, $6, $7::date, $8::time, $9, $10, $11, $12)
       on conflict (request_id) do nothing returning id`,
      [code("APT"), r.id, r.patient_id, a.slotId, a.facilityId, r.service_id, r.slot_date, r.start_time, a.distanceKm, a.preferenceRank, a.rankAtFacility, windowId],
    );
    if (!appt[0]) {
      // Idempotent retry: appointment already exists — release the extra seat.
      await q.query(`update public.appointment_slots set allocated = allocated - 1 where id = $1`, [a.slotId]);
      continue;
    }
    allocated++;
    if (a.preferenceRank === 1) firstChoice++;
    await q.query(`update public.appointment_requests set status = 'allocated', decided_at = now() where id = $1`, [r.id]);
    await q.query(
      `insert into public.patient_notifications (patient_id, request_id, appointment_id, kind, params) values ($1, $2, $3, $4, $5::jsonb)`,
      [r.patient_id, r.id, appt[0].id, outcomeLabel === "reallocated" ? "reallocated" : "allocated",
        JSON.stringify({ facility: slotById.get(a.slotId)?.facilityName, date: r.slot_date, time: r.start_time.slice(0, 5), km: a.distanceKm })],
    );
  }

  for (const w of result.waitlisted) {
    const r = reqById.get(w.requestId)!;
    await q.query(`update public.appointment_requests set status = 'waitlisted', decided_at = now() where id = $1`, [r.id]);
    const alternatives = await alternativesFor(q, r);
    await q.query(
      `insert into public.patient_notifications (patient_id, request_id, kind, params) values ($1, $2, 'waitlisted', $3::jsonb)`,
      [r.patient_id, r.id, JSON.stringify({ reason: w.reason, alternatives, date: r.slot_date, time: r.start_time.slice(0, 5) })],
    );
  }

  for (const d of result.decisions) {
    await q.query(
      `insert into public.allocation_decisions (window_id, request_id, facility_id, slot_id, distance_km, preference_rank, rank_at_facility, outcome, reason)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        windowId, d.requestId, d.facilityId, d.slotId, d.distanceKm, d.preferenceRank,
        result.assignments.find((a) => a.requestId === d.requestId && a.slotId === d.slotId && d.outcome === "allocated")?.rankAtFacility ?? null,
        d.outcome === "allocated" && outcomeLabel === "reallocated" ? "reallocated" : d.outcome, d.reason,
      ],
    );
  }
  return { allocated, waitlisted: result.waitlisted.length, firstChoice, slots: slots.length };
}

// ---------------------------------------------------------------------------
// Batch processing at cutoff (idempotent, retry-safe)
// ---------------------------------------------------------------------------

/** Atomically claim a due window. Returns false if another worker owns it or it is done. */
export async function claimWindow(q: Queryable, windowId: string, trigger: string): Promise<boolean> {
  const rows = await q.query<{ id: string }>(
    `update public.allocation_windows
        set status = 'processing', attempts = attempts + 1, started_at = now(), triggered_by = $2, last_error = null
      where id = $1 and cutoff_at <= now()
        and (status in ('open', 'failed')
             or (status = 'processing' and started_at < now() - ($3::int * interval '1 minute')))
        and attempts < $4
      returning id`,
    [windowId, trigger, ALLOCATION_RULES.staleProcessingMinutes, ALLOCATION_RULES.maxAttempts],
  );
  return !!rows[0];
}

/** Allocate every pending request of a claimed window in ONE transaction. */
export async function processClaimedWindow(q: Queryable, windowId: string) {
  const win = await q.query<{ status: string }>(`select status from public.allocation_windows where id = $1 for update`, [windowId]);
  if (win[0]?.status !== "processing") return { skipped: true as const };
  const pending = await q.query<PendingRequest>(
    `select id, patient_id, service_id, slot_date, start_time::text as start_time, latitude, longitude, preferred_facility_id, tie_key
       from public.appointment_requests
      where window_id = $1 and status = 'pending' and not is_emergency
      order by tie_key
      for update`,
    [windowId],
  );
  const groups = new Map<string, PendingRequest[]>();
  for (const r of pending) {
    const k = `${r.service_id}|${r.slot_date}|${r.start_time}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const summary = { requests: pending.length, groups: groups.size, allocated: 0, waitlisted: 0, firstChoice: 0 };
  for (const g of groups.values()) {
    const r = await allocateGroup(q, windowId, g, "allocated");
    summary.allocated += r.allocated;
    summary.waitlisted += r.waitlisted;
    summary.firstChoice += r.firstChoice;
  }
  await q.query(
    `update public.allocation_windows set status = 'completed', processed_at = now(), summary = $2::jsonb where id = $1`,
    [windowId, JSON.stringify(summary)],
  );
  await q.query(
    `insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, details)
     values (null, 'system', 'allocation.batch_completed', 'allocation_window', $1, $2::jsonb)`,
    [windowId, JSON.stringify(summary)],
  );
  return { skipped: false as const, summary };
}

export async function markWindowFailed(q: Queryable, windowId: string, error: string) {
  await q.query(`update public.allocation_windows set status = 'failed', last_error = $2 where id = $1 and status = 'processing'`, [
    windowId,
    error.slice(0, 500),
  ]);
}

export async function dueWindows(q: Queryable): Promise<{ id: string }[]> {
  return q.query<{ id: string }>(
    `select id from public.allocation_windows
      where cutoff_at <= now() and attempts < $1
        and (status in ('open', 'failed') or (status = 'processing' and started_at < now() - ($2::int * interval '1 minute')))
      order by cutoff_at`,
    [ALLOCATION_RULES.maxAttempts, ALLOCATION_RULES.staleProcessingMinutes],
  );
}

// ---------------------------------------------------------------------------
// Patients and requests
// ---------------------------------------------------------------------------
export interface RegisterInput {
  fullName: string;
  birthYear: number | null;
  sex: "female" | "male" | "other" | "undisclosed";
  phone: string | null;
  addressText: string | null;
  latitude: number;
  longitude: number;
  locationSource: "device" | "locality" | "staff";
  preferredLanguage: "en" | "hi";
  consentData: boolean;
  consentLocation: boolean;
  consentSms: boolean;
  registeredVia: "self" | "assisted";
  registeredBy: string | null;
  isDemo: boolean;
  /** Client-generated key: replays return the same patient and PIN (offline-safe). */
  registrationKey?: string | null;
}

export const CONSENT_NOTICE_VERSION = "2026-10-demo-v1";
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export function newPatientCode(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `SHG-${s}`;
}

/** Round to ~110 m — only approximate location is needed for allocation. */
export const roundCoord = (x: number) => Math.round(x * 1000) / 1000;

export async function nearestDistrict(q: Queryable, lat: number, lon: number): Promise<string | null> {
  const rows = await q.query<{ district_id: string; latitude: number; longitude: number }>(
    `select district_id, latitude, longitude from public.health_centres where latitude is not null`,
  );
  let best: { d: string; km: number } | null = null;
  for (const r of rows) {
    const km = haversineKm({ lat, lon }, { lat: r.latitude, lon: r.longitude });
    if (!best || km < best.km) best = { d: r.district_id, km };
  }
  return best?.d ?? null;
}

export async function registerPatient(q: Queryable, input: RegisterInput): Promise<{ patientId: string; patientCode: string; pin: string }> {
  if (!input.consentData || !input.consentLocation) throw new Error("CONSENT_REQUIRED");
  // PIN is derived from the registration key so a retried submission shows the
  // same PIN; without a key it is random.
  const pin = input.registrationKey
    ? String(100000 + (parseInt(createHmac("sha256", `pin:${sessionSecret()}`).update(input.registrationKey).digest("hex").slice(0, 8), 16) % 900000))
    : String(randomInt(100000, 1000000));
  if (input.registrationKey) {
    const [existing] = await q.query<{ id: string; patient_code: string }>(
      `select id, patient_code from public.patients where registration_key = $1`,
      [input.registrationKey],
    );
    if (existing) return { patientId: existing.id, patientCode: existing.patient_code, pin };
  }
  const lat = roundCoord(input.latitude);
  const lon = roundCoord(input.longitude);
  const district = await nearestDistrict(q, lat, lon);
  for (let attempt = 0; attempt < 5; attempt++) {
    const patientCode = newPatientCode();
    const rows = await q.query<{ id: string }>(
      `insert into public.patients (patient_code, access_pin_hash, full_name, birth_year, sex, phone, address_text, latitude, longitude,
                                    location_source, district_id, preferred_language, registered_via, registered_by, is_demo, registration_key)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       on conflict (patient_code) do nothing returning id`,
      [patientCode, hashPassword(pin), input.fullName, input.birthYear, input.sex, input.phone, input.addressText, lat, lon,
        input.locationSource, district, input.preferredLanguage, input.registeredVia, input.registeredBy, input.isDemo, input.registrationKey ?? null],
    );
    if (!rows[0]) continue;
    const pid = rows[0].id;
    await q.query(
      `insert into public.consent_records (patient_id, consent_type, granted, notice_version) values
         ($1, 'data_processing', $2, $5), ($1, 'location', $3, $5), ($1, 'sms_notifications', $4, $5)`,
      [pid, input.consentData, input.consentLocation, input.consentSms, CONSENT_NOTICE_VERSION],
    );
    await q.query(`insert into public.patient_notifications (patient_id, kind, params) values ($1, 'registered', $2::jsonb)`, [
      pid,
      JSON.stringify({ code: patientCode }),
    ]);
    return { patientId: pid, patientCode, pin };
  }
  throw new Error("Could not generate a unique Patient ID");
}

export async function verifyPatientAccess(q: Queryable, patientCode: string, pin: string): Promise<string | null> {
  const rows = await q.query<{ id: string; access_pin_hash: string }>(
    `select id, access_pin_hash from public.patients where patient_code = $1`,
    [patientCode.trim().toUpperCase()],
  );
  const ok = verifyPassword(pin, rows[0]?.access_pin_hash ?? "scrypt$00$00");
  return rows[0] && ok ? rows[0].id : null;
}

export interface RequestInput {
  patientId: string;
  serviceId: string;
  slotDate: string;
  startTime: string;
  preferredFacilityId: string | null;
  idempotencyKey: string;
  now?: Date;
}

/**
 * Submit a routine request into the currently open window (status
 * "pending"). Emergency services are never batched: they are routed
 * immediately to the nearest operational centre offering emergency care.
 */
export async function submitRequest(q: Queryable, input: RequestInput) {
  const now = input.now ?? new Date();
  const dup = await q.query<{ id: string; request_code: string; status: string; window_id: string | null }>(
    `select id, request_code, status, window_id from public.appointment_requests where idempotency_key = $1`,
    [input.idempotencyKey],
  );
  if (dup[0]) return { ...dup[0], duplicate: true };

  const [patient] = await q.query<{ latitude: number; longitude: number; district_id: string | null }>(
    `select latitude, longitude, district_id from public.patients where id = $1`,
    [input.patientId],
  );
  if (!patient || patient.latitude == null) throw new Error("PATIENT_NOT_FOUND");
  const [service] = await q.query<{ is_emergency: boolean }>(`select is_emergency from public.services where id = $1`, [input.serviceId]);
  if (!service) throw new Error("SERVICE_NOT_FOUND");

  if (service.is_emergency) {
    const centres = await q.query<{ id: string; name: string; facility_type: string; latitude: number; longitude: number }>(
      `select h.id, h.name, h.facility_type, h.latitude, h.longitude from public.health_centres h
         join public.facility_services fs on fs.facility_id = h.id and fs.service_id = $1 and fs.is_active
        where h.operational_status <> 'non_operational' and h.latitude is not null`,
      [input.serviceId],
    );
    const nearest = centres
      .map((c) => ({ ...c, km: Math.round(haversineKm({ lat: patient.latitude, lon: patient.longitude }, { lat: c.latitude, lon: c.longitude }) * 100) / 100 }))
      .sort((a, b) => a.km - b.km)[0];
    const rows = await q.query<{ id: string; request_code: string }>(
      `insert into public.appointment_requests (request_code, patient_id, service_id, slot_date, start_time, latitude, longitude, district_id,
                                                is_emergency, status, tie_key, idempotency_key, decided_at)
       values ($1, $2, $3, $4::date, $5::time, $6, $7, $8, true, 'emergency_referred', $9, $10, now()) returning id, request_code`,
      [code("REQ"), input.patientId, input.serviceId, todayIST(), "00:00", patient.latitude, patient.longitude, patient.district_id,
        tieKey("emergency", input.idempotencyKey), input.idempotencyKey],
    );
    await q.query(
      `insert into public.allocation_decisions (request_id, facility_id, distance_km, outcome, reason) values ($1, $2, $3, 'emergency', $4)`,
      [rows[0].id, nearest?.id ?? null, nearest?.km ?? null, "Emergency: routed immediately to the nearest operational centre; not batched or capacity-limited."],
    );
    await q.query(`insert into public.patient_notifications (patient_id, request_id, kind, params) values ($1, $2, 'emergency', $3::jsonb)`, [
      input.patientId, rows[0].id, JSON.stringify({ facility: nearest?.name ?? null, km: nearest?.km ?? null }),
    ]);
    return { id: rows[0].id, request_code: rows[0].request_code, status: "emergency_referred", window_id: null, duplicate: false, emergency: nearest ?? null };
  }

  const win = await ensureOpenWindow(q, now);
  const slotStart = slotInstant(input.slotDate, input.startTime);
  if (slotStart.getTime() < new Date(win.cutoff_at).getTime() + ALLOCATION_RULES.minLeadMinutes * 60_000) {
    throw new Error("SLOT_TOO_SOON");
  }
  if (input.preferredFacilityId) {
    const eligible = await eligibleSlots(q, input.serviceId, input.slotDate, input.startTime, false);
    if (!eligible.some((s) => s.facilityId === input.preferredFacilityId)) throw new Error("PREFERRED_NOT_ELIGIBLE");
  }
  const id = crypto.randomUUID();
  const rows = await q.query<{ id: string; request_code: string; status: string; window_id: string }>(
    `insert into public.appointment_requests (id, request_code, patient_id, service_id, slot_date, start_time, preferred_facility_id,
                                              latitude, longitude, district_id, window_id, tie_key, idempotency_key)
     values ($1, $2, $3, $4, $5::date, $6::time, $7, $8, $9, $10, $11, $12, $13)
     returning id, request_code, status, window_id`,
    [id, code("REQ"), input.patientId, input.serviceId, input.slotDate, input.startTime, input.preferredFacilityId,
      patient.latitude, patient.longitude, patient.district_id, win.id, tieKey(win.id, id), input.idempotencyKey],
  );
  await q.query(`insert into public.patient_notifications (patient_id, request_id, kind, params) values ($1, $2, 'pending', $3::jsonb)`, [
    input.patientId, id, JSON.stringify({ cutoff: win.cutoff_at, date: input.slotDate, time: input.startTime.slice(0, 5) }),
  ]);
  return { ...rows[0], duplicate: false, cutoff: win.cutoff_at };
}

/**
 * Cancel an appointment, free the seat atomically and immediately offer it to
 * waitlisted patients for the same service/time (nearest-first). Existing
 * confirmed appointments are never moved.
 */
export async function cancelAppointment(q: Queryable, appointmentId: string, reason: string, actor: string | null) {
  const [a] = await q.query<{ id: string; status: string; slot_id: string; request_id: string; patient_id: string; service_id: string; slot_date: string; start_time: string; facility_id: string }>(
    `select id, status, slot_id, request_id, patient_id, service_id, slot_date, start_time::text as start_time, facility_id
       from public.appointments where id = $1 for update`,
    [appointmentId],
  );
  if (!a) throw new Error("APPOINTMENT_NOT_FOUND");
  if (a.status !== "confirmed") throw new Error("APPOINTMENT_NOT_ACTIVE");
  await q.query(`update public.appointments set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1`, [a.id, reason]);
  await q.query(`update public.appointment_slots set allocated = allocated - 1 where id = $1 and allocated > 0`, [a.slot_id]);
  await q.query(`update public.appointment_requests set status = 'cancelled' where id = $1`, [a.request_id]);
  await q.query(
    `insert into public.allocation_decisions (request_id, facility_id, slot_id, outcome, reason) values ($1, $2, $3, 'cancelled', $4)`,
    [a.request_id, a.facility_id, a.slot_id, `Cancelled: ${reason}`],
  );
  await q.query(`insert into public.patient_notifications (patient_id, request_id, appointment_id, kind, params) values ($1, $2, $3, 'cancelled', '{}'::jsonb)`, [
    a.patient_id, a.request_id, a.id,
  ]);
  await q.query(
    `insert into public.audit_logs (actor_id, action, entity_type, entity_id, facility_id, details) values ($1, 'appointment.cancelled', 'appointment', $2, $3, $4::jsonb)`,
    [actor, a.id, a.facility_id, JSON.stringify({ reason })],
  );
  // Reallocate the freed seat (only if the slot is still in the future).
  if (slotInstant(a.slot_date, a.start_time).getTime() > Date.now()) {
    const waiting = await q.query<PendingRequest>(
      `select id, patient_id, service_id, slot_date, start_time::text as start_time, latitude, longitude, preferred_facility_id, tie_key
         from public.appointment_requests
        where status = 'waitlisted' and service_id = $1 and slot_date = $2::date and start_time = $3::time
        for update`,
      [a.service_id, a.slot_date, a.start_time],
    );
    if (waiting.length) return allocateGroup(q, null, waiting, "reallocated");
  }
  return { allocated: 0, waitlisted: 0, firstChoice: 0, slots: 0 };
}

/** Days from today for which slots are offered in the registration form. */
export function bookableDates(today = todayIST()): string[] {
  return [0, 1, 2].map((d) => addDays(today, d));
}
