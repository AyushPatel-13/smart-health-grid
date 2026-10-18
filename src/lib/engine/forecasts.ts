import type { Queryable } from "../db/types";
import type { FacilitySnapshot } from "../data/snapshot";

/** Persist the current forecasts as an auditable snapshot. */
export async function saveForecastSnapshots(
  q: Queryable,
  snaps: FacilitySnapshot[],
  generatedBy: string | null,
): Promise<number> {
  let n = 0;
  for (const s of snaps) {
    const rows: { medicineId: string | null; type: string; f: FacilitySnapshot["footfall"]["forecast"] }[] = [
      { medicineId: null, type: "footfall", f: s.footfall.forecast },
      ...s.medicines.map((m) => ({ medicineId: m.medicineId, type: "medicine_demand", f: m.forecast })),
    ];
    for (const r of rows) {
      if (!r.f.start) continue;
      await q.query(
        `insert into public.forecasts (facility_id, medicine_id, forecast_type, method, horizon_days, history_points,
                                       data_sufficiency, forecast_start, forecast_values, backtest, limitations, generated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12)`,
        [
          s.facility.id, r.medicineId, r.type, r.f.method, r.f.horizonDays, r.f.historyPoints, r.f.sufficiency,
          r.f.start, JSON.stringify(r.f.forecast), r.f.backtest ? JSON.stringify(r.f.backtest) : null,
          JSON.stringify(r.f.limitations), generatedBy,
        ],
      );
      n++;
    }
  }
  return n;
}
