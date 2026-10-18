import { ALLOCATION_RULES } from "../config/rules";
import { haversineKm } from "../analytics/redistribution";
import { todayIST } from "../dates";
import type { Queryable } from "../db/types";
import { loadLiveQueues } from "../operations/live";

// Explainable facility recommendation shown to patients/staff BEFORE the
// batch allocation. Deterministic rules only — no clinical judgement.
// Eligibility: offers the service, operational, meets facility level, required
// test not unavailable, open slot at the requested time, within max distance.
// Ordering: eligible centres by straight-line distance. Workload, doctor
// coverage and test restrictions are shown as information, never hidden.

export interface FacilityRecommendation {
  facilityId: string;
  code: string;
  name: string;
  name_hi: string | null;
  facilityType: string;
  distanceKm: number;
  eligible: boolean;
  seatsLeft: number | null;
  waitingToday: number;
  workloadPct: number | null;
  doctorCoveragePct: number | null;
  reasons: { key: string; params?: Record<string, string | number> }[];
  notes: { key: string; params?: Record<string, string | number> }[];
}

export async function recommendFacilities(
  q: Queryable,
  input: { lat: number; lon: number; serviceId: string; date: string; time: string },
): Promise<FacilityRecommendation[]> {
  const today = todayIST();
  const rows = await q.query<{
    id: string; code: string; name: string; name_hi: string | null; facility_type: string; latitude: number; longitude: number;
    operational_status: string; opd_capacity_per_day: number; offers: boolean; min_type: string; test_status: string | null;
    requires_test: boolean; capacity: number | null; allocated: number | null; waiting: number; visits7: number;
    doctor_shifts: number; doctor_present: number;
  }>(
    `select h.id, h.code, h.name, h.name_hi, h.facility_type, h.latitude, h.longitude, h.operational_status, h.opd_capacity_per_day,
            coalesce(fs.is_active, false) as offers, sv.min_facility_type as min_type,
            (sv.required_test_id is not null) as requires_test,
            (select ds.status from public.diagnostic_services ds where ds.facility_id = h.id and ds.test_id = sv.required_test_id) as test_status,
            sl.capacity, sl.allocated,
            (select count(*)::int from public.visits v where v.facility_id = h.id and v.visit_date = $4::date and v.status = 'waiting') as waiting,
            (select coalesce(sum(opd_visits), 0)::int from public.patient_daily_stats p where p.facility_id = h.id and p.stat_date >= $4::date - 7 and p.stat_date < $4::date) as visits7,
            (select count(*)::int from public.shifts s join public.staff st on st.id = s.staff_id and st.is_doctor
              where s.facility_id = h.id and s.shift_date between $4::date - 6 and $4::date - 1) as doctor_shifts,
            (select count(*)::int from public.shifts s join public.staff st on st.id = s.staff_id and st.is_doctor
               join public.attendance a on a.shift_id = s.id and a.status = 'present'
              where s.facility_id = h.id and s.shift_date between $4::date - 6 and $4::date - 1) as doctor_present
       from public.health_centres h
       cross join public.services sv
       left join public.facility_services fs on fs.facility_id = h.id and fs.service_id = sv.id
       left join public.appointment_slots sl on sl.facility_id = h.id and sl.service_id = sv.id
             and sl.slot_date = $2::date and sl.start_time = $3::time and sl.is_active
      where sv.id = $1 and h.latitude is not null`,
    [input.serviceId, input.date, input.time, today],
  );

  const live = input.date === today ? await loadLiveQueues(q, rows.map((r) => r.id), today) : null;
  return rows
    .map((r) => {
      const km = Math.round(haversineKm({ lat: input.lat, lon: input.lon }, { lat: r.latitude, lon: r.longitude }) * 100) / 100;
      const reasons: FacilityRecommendation["reasons"] = [];
      const notes: FacilityRecommendation["notes"] = [];
      if (!r.offers) reasons.push({ key: "patient.reason.noService" });
      if (r.operational_status === "non_operational") reasons.push({ key: "patient.reason.notOperational" });
      if (r.min_type === "CHC" && r.facility_type !== "CHC") reasons.push({ key: "patient.reason.needsChc" });
      if (r.requires_test && (r.test_status === "unavailable" || r.test_status === null)) reasons.push({ key: "patient.reason.testUnavailable" });
      if (r.offers && r.capacity === null) reasons.push({ key: "patient.reason.noSlot" });
      if (r.capacity !== null && (r.allocated ?? 0) >= r.capacity) reasons.push({ key: "patient.reason.full" });
      if (km > ALLOCATION_RULES.maxDistanceKm) reasons.push({ key: "patient.reason.tooFar", params: { km: ALLOCATION_RULES.maxDistanceKm } });
      if (r.requires_test && r.test_status === "limited") notes.push({ key: "patient.reason.testLimited" });
      const workload = r.visits7 > 0 ? Math.round((r.visits7 / 7 / r.opd_capacity_per_day) * 100) : null;
      if (workload !== null && workload >= 90) notes.push({ key: "patient.reason.highWorkload" });
      const coverage = r.doctor_shifts > 0 ? Math.round((r.doctor_present / r.doctor_shifts) * 100) : null;
      if (coverage !== null && coverage < 70) notes.push({ key: "patient.reason.lowCoverage" });
      const lv = live?.get(r.id);
      if (lv) notes.push(lv.estWaitMinutes === null ? { key: "patient.reason.noDoctorNow" } : { key: "patient.reason.estWait", params: { min: lv.estWaitMinutes } });
      return {
        facilityId: r.id,
        code: r.code,
        name: r.name,
        name_hi: r.name_hi,
        facilityType: r.facility_type,
        distanceKm: km,
        eligible: reasons.length === 0,
        seatsLeft: r.capacity === null ? null : r.capacity - (r.allocated ?? 0),
        waitingToday: r.waiting,
        workloadPct: workload,
        doctorCoveragePct: coverage,
        reasons,
        notes,
      };
    })
    .filter((r) => r.distanceKm <= ALLOCATION_RULES.maxDistanceKm * 1.5)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 10);
}

/** Times with at least one active slot for a service on a date. */
export async function availableTimes(q: Queryable, serviceId: string, date: string): Promise<string[]> {
  const rows = await q.query<{ t: string }>(
    `select distinct start_time::text as t from public.appointment_slots
      where service_id = $1 and slot_date = $2::date and is_active and capacity > 0 order by 1`,
    [serviceId, date],
  );
  return rows.map((r) => r.t.slice(0, 5));
}
