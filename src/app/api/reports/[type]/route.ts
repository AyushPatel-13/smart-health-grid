import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { addDays, todayIST } from "@/lib/dates";
import { loadSnapshots } from "@/lib/data/snapshot";

// CSV exports. Data is loaded under the caller's RLS context, so each user
// only ever exports the facilities they are authorised to see.

function csv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return "﻿" + rows.map((r) => r.map(esc).join(",")).join("\n");
}

export async function GET(_req: Request, ctx: RouteContext<"/api/reports/[type]">) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "NOT_AUTHENTICATED" }, { status: 401 });
  const { type } = await ctx.params;
  const today = todayIST();
  const disclaimer = ["# Smart Health Grid export — SYNTHETIC DEMO DATA if generated in demo mode; not real government data.", `# Generated ${today}`];

  let rows: (string | number | null | undefined)[][];
  if (type === "facilities" || type === "stock") {
    const snaps = await withUser(user.id, (q) => loadSnapshots(q, { today }));
    if (type === "facilities") {
      rows = [
        ["code", "name", "type", "district", "status", "risk_score", "risk_band", "beds_total", "beds_occupied", "beds_out_of_service",
          "beds_available", "opd_last7", "opd_forecast_per_day", "medicines_stock_out", "medicines_critical", "medicines_high",
          "doctor_coverage", "days_without_doctor", "diagnostics_unavailable", "open_alerts", "last_data_update"],
        ...snaps.map((s) => [
          s.facility.code, s.facility.name, s.facility.facility_type, s.facility.district_name, s.facility.operational_status,
          s.risk.score, s.risk.band, s.beds.total, s.beds.occupied, s.beds.outOfService, s.beds.available, s.footfall.last7Total,
          s.footfall.forecast.meanDaily, s.stockCounts.stock_out, s.stockCounts.critical, s.stockCounts.high,
          s.attendance.doctorCoverage, s.attendance.daysWithoutDoctor.length, s.diagnostics.unavailable, s.alerts.open,
          s.facility.last_data_update,
        ]),
      ];
    } else {
      rows = [
        ["facility_code", "facility", "medicine_code", "medicine", "unit", "usable", "expired", "near_expiry", "daily_demand",
          "demand_sufficiency", "days_remaining", "projected_stockout", "safety_stock", "lead_time_days", "risk"],
        ...snaps.flatMap((s) =>
          s.medicines.map((m) => [
            s.facility.code, s.facility.name, m.code, m.name, m.unit, m.assessment.usable, m.assessment.expired, m.assessment.nearExpiry,
            m.assessment.dailyDemand, m.forecast.sufficiency, m.assessment.daysRemaining, m.assessment.projectedStockoutDate,
            m.safetyStock, m.leadTimeDays, m.assessment.risk,
          ]),
        ),
      ];
    }
  } else if (type === "alerts") {
    const data = await withUser(user.id, (q) =>
      q.query<Record<string, string | number | null>>(
        `select h.code as facility_code, h.name as facility, a.category, a.severity, a.status, a.title, a.explanation,
                a.recommended_action, p.full_name as assigned_to, a.created_at, a.updated_at
           from public.alerts a join public.health_centres h on h.id = a.facility_id
           left join public.profiles p on p.id = a.assigned_to
          where a.status <> 'resolved' order by a.created_at desc`,
      ),
    );
    const cols = ["facility_code", "facility", "category", "severity", "status", "title", "explanation", "recommended_action", "assigned_to", "created_at", "updated_at"];
    rows = [cols, ...data.map((r) => cols.map((c) => r[c]))];
  } else if (type === "footfall") {
    const data = await withUser(user.id, (q) =>
      q.query<Record<string, string | number | null>>(
        `select h.code as facility_code, h.name as facility, s.stat_date, s.opd_visits, s.ipd_admissions, s.emergency_visits, s.revision
           from public.patient_daily_stats s join public.health_centres h on h.id = s.facility_id
          where s.stat_date >= $1::date order by h.code, s.stat_date`,
        [addDays(today, -60)],
      ),
    );
    const cols = ["facility_code", "facility", "stat_date", "opd_visits", "ipd_admissions", "emergency_visits", "revision"];
    rows = [cols, ...data.map((r) => cols.map((c) => r[c]))];
  } else {
    return NextResponse.json({ error: "UNKNOWN_REPORT" }, { status: 404 });
  }

  const body = csv([...disclaimer.map((d) => [d]), ...rows]);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shg-${type}-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
