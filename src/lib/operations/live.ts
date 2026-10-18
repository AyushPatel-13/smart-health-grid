import { WORKFORCE_RULES as W } from "../config/rules";
import { haversineKm } from "../analytics/redistribution";
import { addDays } from "../dates";
import type { Queryable } from "../db/types";
import type { DesiredAlert } from "../engine/alerts";
import type { FacilitySnapshot } from "../data/snapshot";
import { computeWorkload, redeploymentRecommendations, type RedeploymentOption } from "../workforce/service";

// Live queue, waiting-time estimates and predictive overload warnings.
//
// Signals are kept strictly separate and labelled:
//   registrations (requests) ≠ bookings (allocated appointments) ≠ visits (check-ins).
// Only check-ins are footfall. Wait estimates use the queue length, doctors
// actually available now and the measured consultation time (if enough data).

export interface LiveLoad {
  facilityId: string;
  waiting: number;
  inConsultation: number;
  completedToday: number;
  checkInsToday: number;
  bookedToday: number;
  bookedNotArrived: number;
  pendingRegistrations: number; // pending requests whose nearest eligible centre is this one
  doctorsVerifiedNow: number;
  doctorsRosteredNow: number;
  consultMinutes: number;
  consultMinutesSource: "measured" | "default";
  estWaitMinutes: number | null; // null = cannot estimate (no doctor available)
  waitBasis: "verified" | "rostered_unverified" | "none";
}

const IST = 330 * 60_000;
function istHourNow(now = new Date()) {
  const d = new Date(now.getTime() + IST);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

export async function loadLiveQueues(q: Queryable, facilityIds: string[], today: string, now = new Date()): Promise<Map<string, LiveLoad>> {
  const hour = istHourNow(now);
  const [visits, appts, shifts, consult, pending, facs] = await Promise.all([
    q.query<{ facility_id: string; status: string; n: number }>(
      `select facility_id, status, count(*)::int as n from public.visits where visit_date = $1::date and facility_id = any($2::uuid[]) group by 1, 2`,
      [today, facilityIds],
    ),
    q.query<{ facility_id: string; booked: number; not_arrived: number }>(
      `select facility_id, count(*) filter (where status in ('confirmed', 'checked_in', 'completed'))::int as booked,
              count(*) filter (where status = 'confirmed')::int as not_arrived
         from public.appointments where slot_date = $1::date and facility_id = any($2::uuid[]) group by 1`,
      [today, facilityIds],
    ),
    q.query<{ facility_id: string; shift_type: string; status: string | null; verification_status: string | null; check_in_at: string | null; check_out_at: string | null }>(
      `select s.facility_id, s.shift_type, a.status, a.verification_status, a.check_in_at, a.check_out_at
         from public.shifts s join public.staff st on st.id = s.staff_id and st.is_doctor
         left join public.attendance a on a.shift_id = s.id
        where s.shift_date = $1::date and s.facility_id = any($2::uuid[])`,
      [today, facilityIds],
    ),
    q.query<{ facility_id: string; minutes: number; n: number }>(
      `select facility_id, avg(extract(epoch from (completed_at - started_at)) / 60)::float8 as minutes, count(*)::int as n
         from public.visits where visit_date = $1::date and status = 'completed' and started_at is not null and completed_at > started_at
          and facility_id = any($2::uuid[]) group by 1`,
      [today, facilityIds],
    ),
    q.query<{ latitude: number; longitude: number; service_id: string }>(
      `select r.latitude, r.longitude, r.service_id from public.appointment_requests r
         join public.allocation_windows w on w.id = r.window_id and w.status = 'open' where r.status = 'pending'`,
    ),
    q.query<{ id: string; latitude: number | null; longitude: number | null; services: string[] }>(
      `select h.id, h.latitude, h.longitude, coalesce(array_agg(fs.service_id::text) filter (where fs.is_active), '{}') as services
         from public.health_centres h left join public.facility_services fs on fs.facility_id = h.id
        where h.id = any($1::uuid[]) group by h.id`,
      [facilityIds],
    ),
  ]);

  // Attribute each pending registration to its nearest centre offering the service.
  const pendingBy = new Map<string, number>();
  for (const r of pending) {
    let best: { id: string; km: number } | null = null;
    for (const f of facs) {
      if (f.latitude == null || f.longitude == null || !f.services.includes(r.service_id)) continue;
      const km = haversineKm({ lat: r.latitude, lon: r.longitude }, { lat: f.latitude, lon: f.longitude });
      if (!best || km < best.km) best = { id: f.id, km };
    }
    if (best) pendingBy.set(best.id, (pendingBy.get(best.id) ?? 0) + 1);
  }

  const out = new Map<string, LiveLoad>();
  for (const id of facilityIds) {
    const v = (s: string) => visits.find((x) => x.facility_id === id && x.status === s)?.n ?? 0;
    const onNow = shifts.filter((s) => {
      if (s.facility_id !== id) return false;
      const [a, b] = W.shiftHours[s.shift_type] ?? [8, 14];
      return hour >= a && hour < b && (W.shiftConsultHours[s.shift_type] ?? 0) > 0;
    });
    const available = onNow.filter((s) => s.status !== "absent" && s.status !== "approved_leave" && !s.check_out_at);
    const verifiedNow = available.filter((s) => s.status === "present" && (s.verification_status === "verified" || !!s.check_in_at)).length;
    const rosteredNow = available.length;
    const c = consult.find((x) => x.facility_id === id);
    const measured = c && c.n >= 3 && c.minutes > 0;
    const consultMinutes = measured ? Math.round(c!.minutes * 10) / 10 : W.consultMinutes;
    const waiting = v("waiting");
    const basis = verifiedNow > 0 ? "verified" : rosteredNow > 0 ? "rostered_unverified" : "none";
    const doctors = verifiedNow > 0 ? verifiedNow : rosteredNow;
    const ap = appts.find((x) => x.facility_id === id);
    out.set(id, {
      facilityId: id,
      waiting,
      inConsultation: v("in_consultation"),
      completedToday: v("completed"),
      checkInsToday: waiting + v("in_consultation") + v("completed") + v("left_without_care"),
      bookedToday: ap?.booked ?? 0,
      bookedNotArrived: ap?.not_arrived ?? 0,
      pendingRegistrations: pendingBy.get(id) ?? 0,
      doctorsVerifiedNow: verifiedNow,
      doctorsRosteredNow: rosteredNow,
      consultMinutes,
      consultMinutesSource: measured ? "measured" : "default",
      estWaitMinutes: doctors > 0 ? Math.round((waiting / doctors) * consultMinutes) : waiting > 0 ? null : 0,
      waitBasis: basis,
    });
  }
  return out;
}

/** Hourly registrations (requests created) today, district-wide — demand signal, not footfall. */
export async function hourlyRegistrations(q: Queryable, today: string): Promise<{ hour: number; n: number }[]> {
  const rows = await q.query<{ hour: number; n: number }>(
    `select extract(hour from created_at at time zone 'Asia/Kolkata')::int as hour, count(*)::int as n
       from public.appointment_requests where (created_at at time zone 'Asia/Kolkata')::date = $1::date group by 1 order by 1`,
    [today],
  );
  return rows;
}

export interface OverloadWarning {
  facilityId: string;
  facilityName: string;
  date: string;
  level: "overload" | "at_risk";
  score: number;
  signals: { key: string; params: Record<string, string | number> }[];
  divertTo: { facilityId: string; name: string; km: number; freeSeats: number; estWaitMinutes: number | null; load: number | null }[];
  staffing: RedeploymentOption[];
}

/**
 * Predictive overload: forecast demand vs safe doctor capacity, slot
 * bookings vs capacity, and (today) the live queue. Recommends nearby
 * centres with spare capacity and safe staffing support. Explainable only.
 */
export async function overloadWarnings(q: Queryable, snaps: FacilitySnapshot[], today: string): Promise<OverloadWarning[]> {
  const ids = snaps.map((s) => s.facility.id);
  const [loads, live, slots, redeploy] = await Promise.all([
    computeWorkload(q, snaps, today),
    loadLiveQueues(q, ids, today),
    q.query<{ facility_id: string; slot_date: string; capacity: number; allocated: number }>(
      `select facility_id, slot_date, sum(capacity)::int as capacity, sum(allocated)::int as allocated from public.appointment_slots
        where slot_date between $1::date and $1::date + 1 and is_active and facility_id = any($2::uuid[]) group by 1, 2`,
      [today, ids],
    ),
    redeploymentRecommendations(q, snaps, today),
  ]);
  const fac = new Map(snaps.map((s) => [s.facility.id, s.facility]));
  const loadOf = (fid: string, date: string) => loads.find((l) => l.facilityId === fid && l.date === date);
  const out: OverloadWarning[] = [];

  for (const date of [today, addDays(today, 1)]) {
    for (const s of snaps) {
      const l = loadOf(s.facility.id, date);
      const sl = slots.find((x) => x.facility_id === s.facility.id && x.slot_date === date);
      const lv = date === today ? live.get(s.facility.id) : undefined;
      const util = l?.utilization ?? null;
      const booked = sl && sl.capacity > 0 ? sl.allocated / sl.capacity : null;
      const waitScore = lv?.estWaitMinutes != null ? lv.estWaitMinutes / 90 : lv && lv.waiting > 0 && lv.estWaitMinutes === null ? 1 : null;
      const score = Math.max(util ?? 0, booked ?? 0, waitScore ?? 0);
      if (score < 0.85) continue;
      const signals: OverloadWarning["signals"] = [];
      if (util !== null && l) signals.push({ key: "overload.signal.capacity", params: { expected: l.expectedPatients ?? 0, required: l.requiredHours ?? 0, safe: l.safeHours, pct: Math.round(util * 100) } });
      if (booked !== null && sl) signals.push({ key: "overload.signal.booked", params: { booked: sl.allocated, capacity: sl.capacity } });
      if (lv) {
        signals.push({ key: "overload.signal.queue", params: { waiting: lv.waiting, wait: lv.estWaitMinutes ?? "?", doctors: lv.doctorsVerifiedNow, rostered: lv.doctorsRosteredNow } });
        if (lv.pendingRegistrations) signals.push({ key: "overload.signal.pending", params: { n: lv.pendingRegistrations } });
      }
      const f = s.facility;
      const divertTo = snaps
        .filter((o) => o.facility.id !== f.id && o.facility.operational_status !== "non_operational" && o.facility.latitude != null && f.latitude != null)
        .map((o) => {
          const ol = loadOf(o.facility.id, date);
          const os = slots.find((x) => x.facility_id === o.facility.id && x.slot_date === date);
          return {
            facilityId: o.facility.id,
            name: o.facility.name,
            km: Math.round(haversineKm({ lat: f.latitude!, lon: f.longitude! }, { lat: o.facility.latitude!, lon: o.facility.longitude! }) * 10) / 10,
            freeSeats: os ? os.capacity - os.allocated : 0,
            estWaitMinutes: date === today ? live.get(o.facility.id)?.estWaitMinutes ?? null : null,
            load: ol?.utilization ?? null,
          };
        })
        .filter((o) => o.km <= 15 && o.freeSeats > 0 && (o.load === null || o.load < 0.7))
        .sort((a, b) => a.km - b.km)
        .slice(0, 3);
      out.push({
        facilityId: f.id,
        facilityName: f.name,
        date,
        level: score >= 1 ? "overload" : "at_risk",
        score: Math.round(score * 100) / 100,
        signals,
        divertTo,
        staffing: redeploy.find((r) => r.recipient.facilityId === f.id && r.date === date)?.options ?? [],
      });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function overloadAlerts(q: Queryable, snaps: FacilitySnapshot[], today: string): Promise<DesiredAlert[]> {
  const warnings = await overloadWarnings(q, snaps, today);
  return warnings.map((w) => ({
    facilityId: w.facilityId,
    category: "overload_risk",
    severity: w.level === "overload" ? "warning" : "info",
    resourceType: "capacity",
    resourceId: null,
    resourceLabel: `Capacity ${w.date}`,
    title: `${w.level === "overload" ? "Overload" : "Overload risk"} expected on ${w.date} (${Math.round(w.score * 100)}% of safe capacity)`,
    explanation: `Combined demand signals reach ${Math.round(w.score * 100)}% of safe capacity. Signals: forecast footfall vs safe doctor-hours, slot bookings vs capacity${w.date === today ? " and the live queue" : ""}.`,
    recommendedAction: w.divertTo.length
      ? `Divert routine bookings to ${w.divertTo.map((d) => `${d.name} (${d.km} km)`).join(", ")}${w.staffing.length ? " and review the staffing support options" : ""}.`
      : w.staffing.length
        ? "Review the approved staffing support options on the Workforce page."
        : "No nearby centre has spare capacity; escalate to the district.",
    supportingValues: { date: w.date, pct: Math.round(w.score * 100), level: w.level },
    dedupeKey: `overload_risk:${w.facilityId}:${w.date}`,
  }));
}
