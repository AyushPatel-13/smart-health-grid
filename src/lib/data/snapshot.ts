import { ALERT_RULES, FORECAST_RULES, STOCK_RULES } from "../config/rules";
import { addDays, diffDays, hoursBetween } from "../dates";
import type { Queryable } from "../db/types";
import { summarizeAttendance, type AttendanceSummary, type ShiftRecord } from "../analytics/attendance";
import { detectSpike, forecastSeries, type ForecastResult, type Point } from "../analytics/forecast";
import { scoreFacility, type RiskScore } from "../analytics/risk";
import {
  assessStock,
  consumptionSeries,
  type BatchInput,
  type DailyMovement,
  type DeliveryInput,
  type StockAssessment,
  type StockRisk,
} from "../analytics/stock";
import type { StockPosition } from "../analytics/redistribution";

export interface FacilityRow {
  id: string;
  code: string;
  name: string;
  name_hi: string | null;
  facility_type: "PHC" | "CHC";
  district_id: string;
  district_name: string;
  district_name_hi: string | null;
  block: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  bed_capacity: number;
  opd_capacity_per_day: number;
  operational_status: "operational" | "limited" | "non_operational";
  last_data_update: string | null;
  is_demo: boolean;
}

export interface MedicineStatus {
  medicineId: string;
  code: string;
  name: string;
  name_hi: string | null;
  unit: string;
  category: string;
  isEssential: boolean;
  safetyStock: number;
  leadTimeDays: number;
  batches: (BatchInput & { source: string })[];
  totalOnHand: number;
  censoredDays: number;
  history: Point[];
  forecast: ForecastResult;
  assessment: StockAssessment;
  deliveries: DeliveryInput[];
}

export interface BedRow {
  id: string;
  ward: string;
  total_beds: number;
  occupied_beds: number;
  out_of_service_beds: number;
  verified_at: string | null;
  updated_at: string;
  stale?: boolean;
}

export interface DiagnosticRow {
  id: string;
  test_id: string;
  code: string;
  name: string;
  name_hi: string | null;
  category: string;
  is_essential: boolean;
  status: "available" | "limited" | "unavailable";
  restriction_note: string | null;
  unavailability_reason: string | null;
  equipment_issue: string | null;
  required_supplies: string | null;
  estimated_restoration_date: string | null;
  last_verified_at: string | null;
  stale: boolean;
}

export interface FacilitySnapshot {
  facility: FacilityRow;
  medicines: MedicineStatus[];
  stockCounts: Record<StockRisk, number>;
  footfall: {
    series: Point[];
    latest: Point | null;
    last7Total: number;
    prev7Total: number;
    daysSinceLastEntry: number | null;
    forecast: ForecastResult;
    spike: ReturnType<typeof detectSpike>;
  };
  beds: {
    wards: BedRow[];
    total: number;
    occupied: number;
    outOfService: number;
    available: number;
    utilization: number | null;
    lastVerifiedAt: string | null;
    stale: boolean;
  };
  attendance: AttendanceSummary;
  diagnostics: {
    services: DiagnosticRow[];
    essential: number;
    essentialUnavailable: number;
    essentialLimited: number;
    unavailable: number;
    stale: number;
  };
  alerts: { open: number; critical: number; warning: number; info: number };
  hoursSinceUpdate: number | null;
  risk: RiskScore;
}

export interface SnapshotOptions {
  today: string;
  facilityIds?: string[] | null;
  /** Skip loading per-medicine detail (faster for list pages). Default false. */
}

const emptyRiskCounts = (): Record<StockRisk, number> => ({
  stock_out: 0,
  critical: 0,
  high: 0,
  low: 0,
  ok: 0,
  no_consumption: 0,
  insufficient_data: 0,
});

function group<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export async function loadFacilities(q: Queryable, facilityIds?: string[] | null): Promise<FacilityRow[]> {
  return q.query<FacilityRow>(
    `select h.id, h.code, h.name, h.name_hi, h.facility_type, h.district_id, d.name as district_name,
            d.name_hi as district_name_hi, h.block, h.address, h.latitude, h.longitude, h.bed_capacity,
            h.opd_capacity_per_day, h.operational_status, h.last_data_update, h.is_demo
       from public.health_centres h
       join public.districts d on d.id = h.district_id
      where ($1::uuid[] is null or h.id = any($1::uuid[]))
      order by h.facility_type desc, h.code`,
    [facilityIds && facilityIds.length ? facilityIds : null],
  );
}

export async function loadSnapshots(q: Queryable, opts: SnapshotOptions): Promise<FacilitySnapshot[]> {
  const { today } = opts;
  const facilities = await loadFacilities(q, opts.facilityIds);
  if (!facilities.length) return [];
  const ids = facilities.map((f) => f.id);
  const yesterday = addDays(today, -1);
  const historyStart = addDays(today, -(STOCK_RULES.consumptionWindowDays + 14));

  const [settings, batches, movements, firstDays, deliveries, stats, beds, shifts, diags, alertCounts] =
    await Promise.all([
      q.query<{
        facility_id: string; medicine_id: string; min_safety_stock: number; lead_time_days: number;
        code: string; name: string; name_hi: string | null; unit: string; category: string; is_essential: boolean;
      }>(
        `select fm.facility_id, fm.medicine_id, fm.min_safety_stock, fm.lead_time_days,
                m.code, m.name, m.name_hi, m.unit, m.category, m.is_essential
           from public.facility_medicines fm join public.medicines m on m.id = fm.medicine_id
          where fm.facility_id = any($1::uuid[])
          order by m.is_essential desc, m.name`,
        [ids],
      ),
      q.query<{
        id: string; facility_id: string; medicine_id: string; batch_number: string;
        quantity_available: number; expiry_date: string; source: string;
      }>(
        `select id, facility_id, medicine_id, batch_number, quantity_available, expiry_date, source
           from public.inventory_batches
          where facility_id = any($1::uuid[]) and quantity_available > 0
          order by expiry_date`,
        [ids],
      ),
      q.query<{ facility_id: string; medicine_id: string; day: string; issued: number; net: number }>(
        `select facility_id, medicine_id,
                (occurred_at at time zone 'Asia/Kolkata')::date::text as day,
                coalesce(-sum(quantity) filter (where txn_type = 'issue'), 0)::int as issued,
                sum(quantity)::int as net
           from public.inventory_transactions
          where facility_id = any($1::uuid[]) and occurred_at >= ($2::date)::timestamptz
          group by 1, 2, 3`,
        [ids, historyStart],
      ),
      q.query<{ facility_id: string; medicine_id: string; first_day: string }>(
        `select facility_id, medicine_id, min((occurred_at at time zone 'Asia/Kolkata')::date)::text as first_day
           from public.inventory_transactions where facility_id = any($1::uuid[])
          group by 1, 2`,
        [ids],
      ),
      q.query<{ facility_id: string; medicine_id: string; quantity: number; expected_date: string }>(
        `select facility_id, medicine_id, quantity, expected_date
           from public.expected_deliveries
          where facility_id = any($1::uuid[]) and status = 'pending' and expected_date >= $2::date`,
        [ids, today],
      ),
      q.query<{ facility_id: string; stat_date: string; opd_visits: number }>(
        `select facility_id, stat_date, opd_visits from public.patient_daily_stats
          where facility_id = any($1::uuid[]) and stat_date >= $2::date - 90 and stat_date <= $2::date
          order by stat_date`,
        [ids, today],
      ),
      q.query<BedRow & { facility_id: string }>(
        `select id, facility_id, ward, total_beds, occupied_beds, out_of_service_beds, verified_at, updated_at
           from public.bed_status where facility_id = any($1::uuid[]) order by ward`,
        [ids],
      ),
      q.query<{
        facility_id: string; shift_id: string; staff_id: string; is_doctor: boolean; shift_date: string;
        shift_type: string; status: ShiftRecord["status"]; verification_status: ShiftRecord["verification"];
      }>(
        `select s.facility_id, s.id as shift_id, s.staff_id, st.is_doctor, s.shift_date, s.shift_type,
                a.status, a.verification_status
           from public.shifts s
           join public.staff st on st.id = s.staff_id
           left join public.attendance a on a.shift_id = s.id
          where s.facility_id = any($1::uuid[])
            and s.shift_date between $2::date - ${ALERT_RULES.staffingWindowDays - 1} and $2::date`,
        [ids, today],
      ),
      q.query<DiagnosticRow & { facility_id: string }>(
        `select ds.id, ds.facility_id, ds.test_id, t.code, t.name, t.name_hi, t.category, t.is_essential, ds.status,
                ds.restriction_note, ds.unavailability_reason, ds.equipment_issue, ds.required_supplies,
                ds.estimated_restoration_date, ds.last_verified_at,
                (ds.last_verified_at is null or ds.last_verified_at < now() - interval '${ALERT_RULES.staleDiagnosticDays} days') as stale
           from public.diagnostic_services ds join public.diagnostic_tests t on t.id = ds.test_id
          where ds.facility_id = any($1::uuid[])
          order by t.is_essential desc, t.name`,
        [ids],
      ),
      q.query<{ facility_id: string; severity: string; n: number }>(
        `select facility_id, severity, count(*)::int as n from public.alerts
          where facility_id = any($1::uuid[]) and status <> 'resolved'
          group by 1, 2`,
        [ids],
      ),
    ]);

  const settingsBy = group(settings, (r) => r.facility_id);
  const batchesBy = group(batches, (r) => `${r.facility_id}:${r.medicine_id}`);
  const movementsBy = group(movements, (r) => `${r.facility_id}:${r.medicine_id}`);
  const firstDayBy = new Map(firstDays.map((r) => [`${r.facility_id}:${r.medicine_id}`, r.first_day]));
  const deliveriesBy = group(deliveries, (r) => `${r.facility_id}:${r.medicine_id}`);
  const statsBy = group(stats, (r) => r.facility_id);
  const bedsBy = group(beds, (r) => r.facility_id);
  const shiftsBy = group(shifts, (r) => r.facility_id);
  const diagsBy = group(diags, (r) => r.facility_id);
  const alertsBy = group(alertCounts, (r) => r.facility_id);

  return facilities.map((facility) => {
    // ---- medicines --------------------------------------------------------
    const stockCounts = emptyRiskCounts();
    const medicines: MedicineStatus[] = (settingsBy.get(facility.id) ?? []).map((s) => {
      const key = `${facility.id}:${s.medicine_id}`;
      const bs = (batchesBy.get(key) ?? []).map((b) => ({
        id: b.id,
        batchNumber: b.batch_number,
        quantity: b.quantity_available,
        expiryDate: b.expiry_date,
        source: b.source,
      }));
      const totalOnHand = bs.reduce((a, b) => a + b.quantity, 0);
      const moves: DailyMovement[] = (movementsBy.get(key) ?? []).map((m) => ({ date: m.day, issued: m.issued, net: m.net }));
      const { series, censoredDays } = consumptionSeries(
        moves,
        totalOnHand,
        firstDayBy.get(key) ?? null,
        yesterday,
        STOCK_RULES.consumptionWindowDays,
      );
      const forecast = forecastSeries(series, yesterday, FORECAST_RULES.horizonDays);
      const dels = (deliveriesBy.get(key) ?? []).map((d) => ({ quantity: d.quantity, expectedDate: d.expected_date }));
      const assessment = assessStock({
        today,
        batches: bs,
        dailyDemand: forecast.meanDaily,
        demandSufficiency: forecast.sufficiency,
        safetyStock: s.min_safety_stock,
        leadTimeDays: s.lead_time_days,
        deliveries: dels,
      });
      stockCounts[assessment.risk]++;
      return {
        medicineId: s.medicine_id,
        code: s.code,
        name: s.name,
        name_hi: s.name_hi,
        unit: s.unit,
        category: s.category,
        isEssential: s.is_essential,
        safetyStock: s.min_safety_stock,
        leadTimeDays: s.lead_time_days,
        batches: bs,
        totalOnHand,
        censoredDays,
        history: series,
        forecast,
        assessment,
        deliveries: dels,
      };
    });

    // ---- footfall ---------------------------------------------------------
    const fSeries: Point[] = (statsBy.get(facility.id) ?? []).map((r) => ({ date: r.stat_date, value: r.opd_visits }));
    const histForForecast = fSeries.filter((p) => p.date < today);
    const latest = fSeries.at(-1) ?? null;
    const sumBetween = (from: string, to: string) =>
      fSeries.filter((p) => p.date >= from && p.date <= to).reduce((a, p) => a + p.value, 0);
    const lastObserved = histForForecast.at(-1)?.date ?? yesterday;
    const footForecast = forecastSeries(histForForecast, lastObserved < yesterday ? yesterday : lastObserved);
    const spike = detectSpike(fSeries, ALERT_RULES.footfallSpikeSigma, ALERT_RULES.footfallSpikeRatio, ALERT_RULES.footfallBaselineDays);

    // ---- beds -------------------------------------------------------------
    const staleCutoff = Date.now() - ALERT_RULES.staleBedHours * 3_600_000;
    const wards = (bedsBy.get(facility.id) ?? []).map((w) => ({
      id: w.id, ward: w.ward, total_beds: w.total_beds, occupied_beds: w.occupied_beds,
      out_of_service_beds: w.out_of_service_beds, verified_at: w.verified_at, updated_at: w.updated_at,
      stale: !w.verified_at || new Date(w.verified_at).getTime() < staleCutoff,
    }));
    const total = wards.reduce((a, w) => a + w.total_beds, 0);
    const occupied = wards.reduce((a, w) => a + w.occupied_beds, 0);
    const oos = wards.reduce((a, w) => a + w.out_of_service_beds, 0);
    const operational = total - oos;
    const lastVerifiedAt =
      wards.map((w) => w.verified_at).filter((v): v is string => !!v).sort().at(-1) ?? null;

    // ---- attendance -------------------------------------------------------
    const records: ShiftRecord[] = (shiftsBy.get(facility.id) ?? []).map((r) => ({
      shiftId: r.shift_id,
      staffId: r.staff_id,
      isDoctor: r.is_doctor,
      shiftDate: r.shift_date,
      shiftType: r.shift_type,
      status: r.status,
      verification: r.verification_status,
    }));
    const attendance = summarizeAttendance(records, today, ALERT_RULES.attendanceReviewShare);

    // ---- diagnostics ------------------------------------------------------
    const services: DiagnosticRow[] = (diagsBy.get(facility.id) ?? []).map((d) => ({ ...d, facility_id: undefined }) as unknown as DiagnosticRow);
    const essential = services.filter((d) => d.is_essential);

    // ---- alerts -----------------------------------------------------------
    const ac = { open: 0, critical: 0, warning: 0, info: 0 };
    for (const a of alertsBy.get(facility.id) ?? []) {
      ac.open += a.n;
      if (a.severity === "critical" || a.severity === "warning" || a.severity === "info") ac[a.severity] += a.n;
    }

    const hoursSinceUpdate = facility.last_data_update ? Math.max(0, hoursBetween(facility.last_data_update)) : null;
    const lastEntryDays = latest ? diffDays(latest.date, today) : null;

    const risk = scoreFacility({
      medicinesTracked: medicines.length,
      medicinesCritical: stockCounts.stock_out + stockCounts.critical,
      medicinesHigh: stockCounts.high,
      projectedDailyFootfall: footForecast.meanDaily,
      opdCapacity: facility.opd_capacity_per_day,
      bedsOperational: operational,
      bedsOccupied: occupied,
      doctorCoverage: attendance.doctorCoverage,
      unverifiedShare: attendance.pastShifts ? attendance.unverifiedOrIncompleteShare : null,
      essentialDiagnostics: essential.length,
      essentialUnavailable: essential.filter((d) => d.status === "unavailable").length,
      essentialLimited: essential.filter((d) => d.status === "limited").length,
      hoursSinceUpdate,
    });

    return {
      facility,
      medicines,
      stockCounts,
      footfall: {
        series: fSeries,
        latest,
        last7Total: sumBetween(addDays(today, -7), yesterday),
        prev7Total: sumBetween(addDays(today, -14), addDays(today, -8)),
        daysSinceLastEntry: lastEntryDays,
        forecast: footForecast,
        spike,
      },
      beds: {
        wards,
        total,
        occupied,
        outOfService: oos,
        available: Math.max(0, total - occupied - oos),
        utilization: operational > 0 ? Math.round((occupied / operational) * 100) / 100 : null,
        lastVerifiedAt,
        stale: !lastVerifiedAt || new Date(lastVerifiedAt).getTime() < staleCutoff,
      },
      attendance,
      diagnostics: {
        services,
        essential: essential.length,
        essentialUnavailable: essential.filter((d) => d.status === "unavailable").length,
        essentialLimited: essential.filter((d) => d.status === "limited").length,
        unavailable: services.filter((d) => d.status === "unavailable").length,
        stale: services.filter((d) => d.stale).length,
      },
      alerts: ac,
      hoursSinceUpdate,
      risk,
    };
  });
}

/** Flatten snapshots into the stock positions used by the redistribution engine. */
export function toStockPositions(snaps: FacilitySnapshot[]): StockPosition[] {
  return snaps.flatMap((s) =>
    s.medicines.map((m) => ({
      facilityId: s.facility.id,
      facilityName: s.facility.name,
      medicineId: m.medicineId,
      medicineName: m.name,
      unit: m.unit,
      latitude: s.facility.latitude,
      longitude: s.facility.longitude,
      batches: m.batches,
      usable: m.assessment.usable,
      dailyDemand: m.assessment.dailyDemand,
      safetyStock: m.safetyStock,
      leadTimeDays: m.leadTimeDays,
      risk: m.assessment.risk,
      daysUntilStockout: m.assessment.daysUntilStockout,
      deliveries: m.deliveries,
    })),
  );
}
