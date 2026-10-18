import { ALERT_RULES, STOCK_RULES } from "../config/rules";
import type { Queryable } from "../db/types";
import type { FacilitySnapshot } from "../data/snapshot";

// Deterministic alert rules. Each rule produces a stable dedupe key per
// underlying issue, so re-running the engine updates the existing active alert
// instead of creating duplicates, and auto-resolves alerts whose condition has
// cleared. Text is stored in English; the UI renders translated templates from
// `supporting_values`.

export type Severity = "critical" | "warning" | "info";

export interface DesiredAlert {
  facilityId: string;
  category: string;
  severity: Severity;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  title: string;
  explanation: string;
  recommendedAction: string;
  supportingValues: Record<string, string | number | boolean | null>;
  dedupeKey: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function evaluateRules(snaps: FacilitySnapshot[], today: string): DesiredAlert[] {
  const out: DesiredAlert[] = [];
  for (const s of snaps) {
    const f = s.facility;
    const base = (category: string, suffix: string) => `${category}:${f.id}:${suffix}`;

    // ---- medicines --------------------------------------------------------
    for (const m of s.medicines) {
      const a = m.assessment;
      const common = {
        medicine: m.name,
        medicine_hi: m.name_hi ?? m.name,
        unit: m.unit,
        usable: a.usable,
        demand: a.dailyDemand,
        safety: m.safetyStock,
        lead: m.leadTimeDays,
      };
      if (a.risk === "stock_out") {
        out.push({
          facilityId: f.id,
          category: "stock_out",
          severity: m.isEssential ? "critical" : "warning",
          resourceType: "medicine",
          resourceId: m.medicineId,
          resourceLabel: m.name,
          title: `${m.name} is out of stock`,
          explanation:
            `No usable (non-expired) stock of ${m.name} remains at ${f.name}.` +
            (a.expired > 0 ? ` ${a.expired} ${m.unit}(s) on the shelf are expired.` : "") +
            (a.dailyDemand ? ` Recent demand is about ${a.dailyDemand} ${m.unit}(s)/day.` : ""),
          recommendedAction: "Arrange an emergency transfer from a facility with surplus and expedite the pending supply order.",
          supportingValues: { ...common, expired: a.expired, nextDelivery: a.nextDelivery?.expectedDate ?? null },
          dedupeKey: base("stock_out", m.medicineId),
        });
      } else if (a.risk === "critical" || a.risk === "high") {
        out.push({
          facilityId: f.id,
          category: "stock_risk",
          severity: a.risk === "critical" ? "critical" : "warning",
          resourceType: "medicine",
          resourceId: m.medicineId,
          resourceLabel: m.name,
          title: `${m.name} projected to stock out in ${a.daysUntilStockout} day(s)`,
          explanation:
            `${a.usable} usable ${m.unit}(s) at ~${a.dailyDemand}/day; projected stock-out on ${a.projectedStockoutDate}. ` +
            `Replenishment lead time is ${m.leadTimeDays} day(s).` +
            (a.nextDelivery
              ? a.deliveryBeforeStockout
                ? ` A delivery of ${a.nextDelivery.quantity} is expected on ${a.nextDelivery.expectedDate}.`
                : ` The next delivery (${a.nextDelivery.expectedDate}) arrives after the projected stock-out.`
              : " No delivery is scheduled."),
          recommendedAction:
            a.risk === "critical"
              ? "Review the redistribution recommendation and approve a transfer; raise an urgent indent."
              : "Place a replenishment order now to arrive before the projected stock-out.",
          supportingValues: {
            ...common,
            days: a.daysUntilStockout,
            stockoutDate: a.projectedStockoutDate,
            nextDelivery: a.nextDelivery?.expectedDate ?? null,
          },
          dedupeKey: base("stock_risk", m.medicineId),
        });
      } else if (a.risk === "low") {
        out.push({
          facilityId: f.id,
          category: "low_stock",
          severity: "info",
          resourceType: "medicine",
          resourceId: m.medicineId,
          resourceLabel: m.name,
          title: `${m.name} below safety stock`,
          explanation: `${a.usable} usable ${m.unit}(s) is below the minimum safety stock of ${m.safetyStock}.`,
          recommendedAction: "Raise a routine replenishment indent.",
          supportingValues: common,
          dedupeKey: base("low_stock", m.medicineId),
        });
      }

      if (a.expired > 0) {
        out.push({
          facilityId: f.id,
          category: "expired_stock",
          severity: "warning",
          resourceType: "medicine",
          resourceId: m.medicineId,
          resourceLabel: m.name,
          title: `Expired ${m.name} on the shelf`,
          explanation: `${a.expired} ${m.unit}(s) of ${m.name} are past expiry and must not be issued.`,
          recommendedAction: "Quarantine and record an expiry write-off for the expired batch(es).",
          supportingValues: { ...common, qty: a.expired },
          dedupeKey: base("expired_stock", m.medicineId),
        });
      }
      if (a.projectedWastage > 0 && a.nearExpiry > 0) {
        const first = m.batches.find((b) => b.expiryDate >= today);
        out.push({
          facilityId: f.id,
          category: "near_expiry",
          severity: "warning",
          resourceType: "medicine",
          resourceId: m.medicineId,
          resourceLabel: m.name,
          title: `${m.name}: ${a.projectedWastage} likely to expire unused`,
          explanation:
            `${a.nearExpiry} ${m.unit}(s) expire within ${STOCK_RULES.nearExpiryDays} days; at current demand about ${a.projectedWastage} will expire before use.`,
          recommendedAction: "Transfer the near-expiry quantity to a facility with higher demand.",
          supportingValues: { ...common, qty: a.nearExpiry, wastage: a.projectedWastage, date: first?.expiryDate ?? null },
          dedupeKey: base("near_expiry", m.medicineId),
        });
      }
    }

    // ---- beds ---------------------------------------------------------------
    const operational = s.beds.total - s.beds.outOfService;
    if (operational > 0 && s.beds.utilization !== null && s.beds.utilization >= ALERT_RULES.bedWarningUtilization) {
      const fullWards = s.beds.wards.filter((w) => w.total_beds - w.out_of_service_beds > 0 && w.occupied_beds >= w.total_beds - w.out_of_service_beds);
      out.push({
        facilityId: f.id,
        category: "bed_capacity",
        severity: s.beds.available === 0 ? "critical" : "warning",
        resourceType: "beds",
        resourceId: null,
        resourceLabel: "Beds",
        title: s.beds.available === 0 ? "No beds available" : `Bed occupancy at ${pct(s.beds.utilization)}`,
        explanation:
          `${s.beds.occupied} of ${operational} operational beds occupied (${s.beds.outOfService} out of service).` +
          (fullWards.length ? ` Full wards: ${fullWards.map((w) => w.ward).join(", ")}.` : ""),
        recommendedAction: "Identify referral capacity at nearby CHCs and expedite repair of out-of-service beds.",
        supportingValues: {
          occupied: s.beds.occupied,
          operational,
          available: s.beds.available,
          oos: s.beds.outOfService,
          utilization: Math.round(s.beds.utilization * 100),
          wards: fullWards.map((w) => w.ward).join(", "),
        },
        dedupeKey: base("bed_capacity", "all"),
      });
    }

    // ---- staffing -----------------------------------------------------------
    const att = s.attendance;
    if (att.daysWithoutDoctor.length > 0) {
      out.push({
        facilityId: f.id,
        category: "staffing_gap",
        severity: att.daysWithoutDoctor.length >= 2 ? "critical" : "warning",
        resourceType: "staff",
        resourceId: null,
        resourceLabel: "Doctors",
        title: `No doctor recorded present on ${att.daysWithoutDoctor.length} day(s)`,
        explanation:
          `In the last ${ALERT_RULES.staffingWindowDays} days, rostered doctor shifts had no present record on ` +
          `${att.daysWithoutDoctor.join(", ")}. Doctor coverage: ${att.doctorCoverage === null ? "n/a" : pct(att.doctorCoverage)}. ` +
          "Missing records are treated as incomplete, not as confirmed absence.",
        recommendedAction: "Verify attendance with the medical officer in-charge and arrange a substitute or deputation.",
        supportingValues: {
          days: att.daysWithoutDoctor.length,
          dates: att.daysWithoutDoctor.join(", "),
          coverage: att.doctorCoverage === null ? null : Math.round(att.doctorCoverage * 100),
        },
        dedupeKey: base("staffing_gap", "doctor"),
      });
    }
    if (att.pastShifts > 0 && att.unverifiedOrIncompleteShare >= ALERT_RULES.attendanceReviewShare) {
      out.push({
        facilityId: f.id,
        category: "staffing_gap",
        severity: "info",
        resourceType: "attendance",
        resourceId: null,
        resourceLabel: "Attendance records",
        title: `${pct(att.unverifiedOrIncompleteShare)} of shifts unverified or incomplete`,
        explanation:
          `${att.counts.unverified} unverified and ${att.counts.incomplete} incomplete shift record(s) out of ${att.pastShifts} ` +
          `in the last ${ALERT_RULES.staffingWindowDays} days.`,
        recommendedAction: "Review and verify pending attendance records.",
        supportingValues: {
          unverified: att.counts.unverified,
          incomplete: att.counts.incomplete,
          total: att.pastShifts,
          share: Math.round(att.unverifiedOrIncompleteShare * 100),
        },
        dedupeKey: base("staffing_gap", "records"),
      });
    }

    // ---- diagnostics --------------------------------------------------------
    for (const d of s.diagnostics.services) {
      if (d.status === "unavailable") {
        out.push({
          facilityId: f.id,
          category: "diagnostic_unavailable",
          severity: d.is_essential ? "warning" : "info",
          resourceType: "diagnostic",
          resourceId: d.test_id,
          resourceLabel: d.name,
          title: `${d.name} unavailable`,
          explanation:
            `${d.name} is not available: ${d.unavailability_reason ?? "reason not recorded"}.` +
            (d.estimated_restoration_date ? ` Estimated restoration: ${d.estimated_restoration_date}.` : " No restoration date recorded."),
          recommendedAction: d.required_supplies
            ? `Arrange supply of: ${d.required_supplies}. Refer patients to the nearest facility offering the test.`
            : "Arrange repair or supplies and refer patients to the nearest facility offering the test.",
          supportingValues: {
            test: d.name,
            test_hi: d.name_hi ?? d.name,
            reason: d.unavailability_reason,
            restoration: d.estimated_restoration_date,
            essential: d.is_essential,
          },
          dedupeKey: base("diagnostic_unavailable", d.test_id),
        });
      }
    }
    if (s.diagnostics.stale > 0) {
      out.push({
        facilityId: f.id,
        category: "diagnostic_stale",
        severity: "info",
        resourceType: "diagnostic",
        resourceId: null,
        resourceLabel: "Diagnostic status",
        title: `${s.diagnostics.stale} diagnostic status record(s) not verified recently`,
        explanation: `Status not verified in the last ${ALERT_RULES.staleDiagnosticDays} days; availability shown may be outdated.`,
        recommendedAction: "Ask the facility lab to re-verify test availability.",
        supportingValues: { count: s.diagnostics.stale, days: ALERT_RULES.staleDiagnosticDays },
        dedupeKey: base("diagnostic_stale", "all"),
      });
    }

    // ---- footfall -----------------------------------------------------------
    const sp = s.footfall.spike;
    if (sp.isSpike && sp.latest && (s.footfall.daysSinceLastEntry ?? 99) <= 2) {
      out.push({
        facilityId: f.id,
        category: "footfall_spike",
        severity: "warning",
        resourceType: "footfall",
        resourceId: null,
        resourceLabel: "OPD visits",
        title: `Unusual OPD increase: ${sp.latest.value} visits`,
        explanation:
          `${sp.latest.value} OPD visits on ${sp.latest.date} vs an expected ~${sp.baselineMean} ` +
          `(${sp.ratio}× the weekday-adjusted ${ALERT_RULES.footfallBaselineDays}-day baseline).`,
        recommendedAction: "Check for a local outbreak or event; review medicine buffers and staff rosters.",
        supportingValues: { visits: sp.latest.value, date: sp.latest.date, baseline: sp.baselineMean, ratio: sp.ratio },
        dedupeKey: base("footfall_spike", "opd"),
      });
    }

    // ---- data freshness ------------------------------------------------------
    const daysSince = s.footfall.daysSinceLastEntry;
    if ((daysSince !== null && daysSince > ALERT_RULES.staleFootfallDays) || daysSince === null) {
      out.push({
        facilityId: f.id,
        category: "stale_data",
        severity: "warning",
        resourceType: "footfall",
        resourceId: null,
        resourceLabel: "Daily reporting",
        title: daysSince === null ? "No patient footfall data reported" : `No footfall report for ${daysSince} day(s)`,
        explanation:
          daysSince === null
            ? "No daily patient statistics are on record."
            : `The latest daily patient statistics are from ${s.footfall.latest?.date}. Forecasts and dashboards for this facility may be outdated.`,
        recommendedAction: "Contact the facility to submit pending daily reports.",
        supportingValues: { days: daysSince, last: s.footfall.latest?.date ?? null },
        dedupeKey: base("stale_data", "footfall"),
      });
    }
  }
  return out;
}

interface ExistingAlert {
  id: string;
  dedupe_key: string;
  severity: string;
  title: string;
}

/**
 * Reconcile desired rule alerts with stored ones for the evaluated facilities.
 * Runs in the trusted system context.
 */
export async function syncAlerts(
  q: Queryable,
  snaps: FacilitySnapshot[],
  today: string,
  extra: DesiredAlert[] = [],
): Promise<{ created: number; updated: number; resolved: number }> {
  const facilityIds = snaps.map((s) => s.facility.id);
  if (!facilityIds.length) return { created: 0, updated: 0, resolved: 0 };
  const desired = [...evaluateRules(snaps, today), ...extra];
  const existing = await q.query<ExistingAlert>(
    `select id, dedupe_key, severity, title from public.alerts
      where source = 'rule' and status <> 'resolved' and facility_id = any($1::uuid[])`,
    [facilityIds],
  );
  const byKey = new Map(existing.map((e) => [e.dedupe_key, e]));
  let created = 0;
  let updated = 0;
  let resolved = 0;

  for (const d of desired) {
    const e = byKey.get(d.dedupeKey);
    if (e) {
      byKey.delete(d.dedupeKey);
      await q.query(
        `update public.alerts set severity = $2, title = $3, explanation = $4, recommended_action = $5,
                supporting_values = $6::jsonb, last_evaluated_at = now()
          where id = $1`,
        [e.id, d.severity, d.title, d.explanation, d.recommendedAction, JSON.stringify(d.supportingValues)],
      );
      if (e.severity !== d.severity) {
        updated++;
        await q.query(
          `insert into public.alert_events (alert_id, event_type, notes, details) values ($1, 'updated', $2, $3::jsonb)`,
          [e.id, `Severity changed from ${e.severity} to ${d.severity}`, JSON.stringify({ from: e.severity, to: d.severity })],
        );
      }
      continue;
    }
    const rows = await q.query<{ id: string }>(
      `insert into public.alerts (facility_id, category, severity, resource_type, resource_id, resource_label, title,
                                  explanation, supporting_values, recommended_action, source, dedupe_key, last_evaluated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'rule', $11, now())
       on conflict (dedupe_key) where status <> 'resolved' and dedupe_key is not null do nothing
       returning id`,
      [
        d.facilityId, d.category, d.severity, d.resourceType, d.resourceId, d.resourceLabel, d.title,
        d.explanation, JSON.stringify(d.supportingValues), d.recommendedAction, d.dedupeKey,
      ],
    );
    if (rows[0]) {
      created++;
      await q.query(
        `insert into public.alert_events (alert_id, event_type, notes) values ($1, 'created', 'Generated by rule engine')`,
        [rows[0].id],
      );
    }
  }

  for (const stale of byKey.values()) {
    resolved++;
    await q.query(
      `update public.alerts set status = 'resolved', resolved_at = now(),
              resolution_notes = 'Auto-resolved: condition no longer detected by the rule engine.'
        where id = $1`,
      [stale.id],
    );
    await q.query(
      `insert into public.alert_events (alert_id, event_type, notes) values ($1, 'auto_resolved', 'Condition cleared')`,
      [stale.id],
    );
  }
  return { created, updated, resolved };
}
