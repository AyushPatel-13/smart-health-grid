import { WORKFORCE_RULES as W } from "../config/rules";
import { addDays } from "../dates";
import { haversineKm } from "../analytics/redistribution";
import type { Queryable } from "../db/types";
import type { DesiredAlert } from "../engine/alerts";
import type { FacilitySnapshot } from "../data/snapshot";

// Doctor workload vs. safe staffing capacity, and explainable temporary
// redeployment recommendations. Registrations are NEVER treated as arrivals:
// expected patients come from the footfall forecast (built on actual check-ins
// and daily reports); booked appointments are shown separately.

export interface DoctorShift {
  shift_id: string;
  facility_id: string;
  staff_id: string;
  full_name: string;
  designation: string;
  shift_date: string;
  shift_type: string;
  status: string | null;
  reassignment_id: string | null;
  registration_verified: boolean;
  qualification: string | null;
}

export interface FacilityDayLoad {
  facilityId: string;
  facilityName: string;
  facilityType: string;
  date: string;
  expectedPatients: number | null;
  bookedAppointments: number;
  requiredHours: number | null;
  availableHours: number;
  safeHours: number;
  doctorsRostered: number;
  shortfallHours: number;
  utilization: number | null;
  dataNote: "forecast" | "recent_average" | "no_data";
}

export interface RedeploymentOption {
  staffId: string;
  staffName: string;
  shiftId: string;
  shiftType: string;
  fromFacilityId: string;
  fromFacilityName: string;
  distanceKm: number | null;
  travelMinutes: number | null;
  hoursProvided: number;
  donorDoctorsAfter: number;
  donorMinDoctors: number;
  donorUtilizationBefore: number | null;
  donorUtilizationAfter: number | null;
  recipientUtilizationAfter: number | null;
}

export interface RedeploymentRecommendation {
  key: string;
  date: string;
  recipient: FacilityDayLoad;
  urgency: "critical" | "high" | "medium";
  options: RedeploymentOption[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function loadDoctorShifts(q: Queryable, from: string, to: string): Promise<DoctorShift[]> {
  return q.query<DoctorShift>(
    `select s.id as shift_id, s.facility_id, s.staff_id, st.full_name, st.designation, s.shift_date, s.shift_type, a.status,
            s.reassignment_id, st.registration_verified, st.qualification
       from public.shifts s
       join public.staff st on st.id = s.staff_id and st.is_doctor and st.is_active
       left join public.attendance a on a.shift_id = s.id
      where s.shift_date between $1::date and $2::date`,
    [from, to],
  );
}

/** Doctor-hours a shift contributes; leave and recorded absences contribute nothing. */
function contributes(s: DoctorShift): number {
  if (s.status === "approved_leave" || s.status === "absent") return 0;
  return W.shiftConsultHours[s.shift_type] ?? 0;
}

export async function computeWorkload(q: Queryable, snaps: FacilitySnapshot[], today: string): Promise<FacilityDayLoad[]> {
  const to = addDays(today, W.horizonDays - 1);
  const shifts = await loadDoctorShifts(q, today, to);
  const appts = await q.query<{ facility_id: string; slot_date: string; n: number }>(
    `select facility_id, slot_date, count(*)::int as n from public.appointments
      where slot_date between $1::date and $2::date and status in ('confirmed', 'checked_in') group by 1, 2`,
    [today, to],
  );
  const out: FacilityDayLoad[] = [];
  for (const s of snaps) {
    for (let i = 0; i < W.horizonDays; i++) {
      const date = addDays(today, i);
      const fc = s.footfall.forecast.forecast.find((f) => f.date === date);
      const avg7 = s.footfall.series.length ? s.footfall.last7Total / 7 : null;
      const expected = fc ? fc.value : avg7;
      const dataNote = fc ? "forecast" : avg7 !== null ? "recent_average" : "no_data";
      const dayShifts = shifts.filter((x) => x.facility_id === s.facility.id && x.shift_date === date);
      const available = dayShifts.reduce((a, x) => a + contributes(x), 0);
      const safe = available * W.safeUtilization;
      const required = expected === null ? null : (expected * W.consultMinutes) / 60;
      out.push({
        facilityId: s.facility.id,
        facilityName: s.facility.name,
        facilityType: s.facility.facility_type,
        date,
        expectedPatients: expected === null ? null : Math.round(expected),
        bookedAppointments: appts.find((a) => a.facility_id === s.facility.id && a.slot_date === date)?.n ?? 0,
        requiredHours: required === null ? null : r2(required),
        availableHours: available,
        safeHours: r2(safe),
        doctorsRostered: new Set(dayShifts.filter((x) => contributes(x) > 0).map((x) => x.staff_id)).size,
        shortfallHours: required === null ? 0 : r2(Math.max(0, required - safe)),
        utilization: required === null || safe === 0 ? (required ? 9.99 : null) : r2(required / safe),
        dataNote,
      });
    }
  }
  return out;
}

export async function redeploymentRecommendations(
  q: Queryable,
  snaps: FacilitySnapshot[],
  today: string,
): Promise<RedeploymentRecommendation[]> {
  const loads = await computeWorkload(q, snaps, today);
  const shifts = await loadDoctorShifts(q, today, addDays(today, W.horizonDays - 1));
  const fac = new Map(snaps.map((s) => [s.facility.id, s.facility]));
  const loadBy = new Map(loads.map((l) => [`${l.facilityId}:${l.date}`, l]));
  const out: RedeploymentRecommendation[] = [];

  for (const need of loads.filter((l) => l.shortfallHours > 0 && l.requiredHours !== null)) {
    const recipient = fac.get(need.facilityId)!;
    const options: RedeploymentOption[] = [];
    for (const s of shifts) {
      if (s.facility_id === need.facilityId || s.shift_date !== need.date || s.reassignment_id) continue;
      if (s.designation !== "medical_officer") continue; // general OPD capability
      if (!s.registration_verified) continue; // only doctors with a verified registration
      const hours = contributes(s);
      if (hours <= 0) continue;
      const donor = fac.get(s.facility_id);
      if (!donor) continue;
      const donorLoad = loadBy.get(`${s.facility_id}:${need.date}`);
      if (!donorLoad) continue;
      const minDoctors = W.minDoctorsPerDay[donor.facility_type] ?? 1;
      const doctorsAfter = donorLoad.doctorsRostered - 1;
      if (doctorsAfter < minDoctors) continue; // never strip essential staffing
      const donorSafeAfter = (donorLoad.availableHours - hours) * W.safeUtilization;
      const donorUtilAfter = donorLoad.requiredHours === null ? null : donorSafeAfter > 0 ? r2(donorLoad.requiredHours / donorSafeAfter) : 9.99;
      if (donorUtilAfter !== null && donorUtilAfter > 1) continue; // donor would become unsafe
      const km =
        recipient.latitude != null && donor.latitude != null
          ? Math.round(haversineKm({ lat: recipient.latitude, lon: recipient.longitude! }, { lat: donor.latitude, lon: donor.longitude! }) * 1.3 * 10) / 10
          : null;
      const recipSafeAfter = need.safeHours + hours * W.safeUtilization;
      options.push({
        staffId: s.staff_id,
        staffName: s.full_name,
        shiftId: s.shift_id,
        shiftType: s.shift_type,
        fromFacilityId: s.facility_id,
        fromFacilityName: donor.name,
        distanceKm: km,
        travelMinutes: km === null ? null : Math.round((km / 30) * 60),
        hoursProvided: hours,
        donorDoctorsAfter: doctorsAfter,
        donorMinDoctors: minDoctors,
        donorUtilizationBefore: donorLoad.utilization,
        donorUtilizationAfter: donorUtilAfter,
        recipientUtilizationAfter: recipSafeAfter > 0 ? r2((need.requiredHours ?? 0) / recipSafeAfter) : null,
      });
    }
    options.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || (a.donorUtilizationAfter ?? 0) - (b.donorUtilizationAfter ?? 0));
    out.push({
      key: `${need.facilityId}:${need.date}`,
      date: need.date,
      recipient: need,
      urgency: need.date === today ? "critical" : need.shortfallHours >= 6 ? "high" : "medium",
      options: options.slice(0, 3),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || b.recipient.shortfallHours - a.recipient.shortfallHours);
}

export async function workforceAlerts(q: Queryable, snaps: FacilitySnapshot[], today: string): Promise<DesiredAlert[]> {
  const loads = await computeWorkload(q, snaps, today);
  const alerts: DesiredAlert[] = loads
    .filter((l) => l.shortfallHours > 0 && l.date <= addDays(today, 1))
    .map((l) => ({
      facilityId: l.facilityId,
      category: "workload_staffing",
      severity: l.date === today && l.shortfallHours >= 6 ? "critical" : "warning",
      resourceType: "staff",
      resourceId: null,
      resourceLabel: `Doctor-hours ${l.date}`,
      title: `Projected demand exceeds safe doctor capacity on ${l.date}`,
      explanation:
        `~${l.expectedPatients} expected patients need ~${l.requiredHours} doctor-hours; ${l.availableHours} rostered hours ` +
        `(${l.safeHours} safely usable). Shortfall ${l.shortfallHours} h. Expected patients are from the footfall forecast, not registrations.`,
      recommendedAction: "Review the temporary redeployment recommendations on the Workforce page.",
      supportingValues: { date: l.date, expected: l.expectedPatients, required: l.requiredHours, safe: l.safeHours, shortfall: l.shortfallHours },
      dedupeKey: `workload_staffing:${l.facilityId}:${l.date}`,
    }));
  const review = await q.query<{ facility_id: string; n: number }>(
    `select facility_id, count(*)::int as n from public.attendance where review_status = 'needs_review' group by 1`,
  );
  for (const r of review) {
    if (!snaps.some((s) => s.facility.id === r.facility_id)) continue;
    alerts.push({
      facilityId: r.facility_id,
      category: "attendance_review",
      severity: "info",
      resourceType: "attendance",
      resourceId: null,
      resourceLabel: "Attendance review",
      title: `${r.n} attendance record(s) need manual review`,
      explanation: "Mobile check-in/out could not be fully verified (location, accuracy, identity or duration). This is not a finding of absence or misconduct.",
      recommendedAction: "Review the records and verify or correct them.",
      supportingValues: { count: r.n },
      dedupeKey: `attendance_review:${r.facility_id}`,
    });
  }
  return alerts;
}
