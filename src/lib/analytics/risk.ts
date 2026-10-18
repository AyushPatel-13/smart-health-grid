import { RISK_BANDS, RISK_WEIGHTS, type RiskFactorKey } from "../config/rules";

// Documented, rule-based facility risk score (0–100). Each factor is
// normalised to 0..1 by a stated formula, multiplied by its weight, and
// returned with its raw inputs so the UI can show exactly why a facility
// ranks where it does. Factors with no data contribute 0 and are flagged.

export interface FacilitySignals {
  medicinesTracked: number;
  medicinesCritical: number; // stock_out + critical
  medicinesHigh: number;
  projectedDailyFootfall: number | null;
  opdCapacity: number;
  bedsOperational: number; // total - out of service
  bedsOccupied: number;
  doctorCoverage: number | null;
  unverifiedShare: number | null;
  essentialDiagnostics: number;
  essentialUnavailable: number;
  essentialLimited: number;
  hoursSinceUpdate: number | null;
}

export interface RiskFactor {
  key: RiskFactorKey;
  weight: number;
  /** 0..1, null if no data */
  normalized: number | null;
  contribution: number;
  /** Human-readable raw inputs (numbers only; labels are translated in UI) */
  inputs: Record<string, number | string | null>;
}

export interface RiskScore {
  score: number;
  band: "high" | "medium" | "low";
  factors: RiskFactor[];
  missingData: RiskFactorKey[];
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const r2 = (x: number) => Math.round(x * 100) / 100;

export function scoreFacility(s: FacilitySignals): RiskScore {
  const factors: RiskFactor[] = [];
  const push = (key: RiskFactorKey, normalized: number | null, inputs: RiskFactor["inputs"]) => {
    const weight = RISK_WEIGHTS[key];
    const n = normalized === null ? null : r2(clamp01(normalized));
    factors.push({ key, weight, normalized: n, contribution: n === null ? 0 : Math.round(n * weight * 10) / 10, inputs });
  };

  // 1. Medicine shortages: critical items count double. 25% of the list
  //    critical (or 50% high) saturates the factor.
  push(
    "medicine_shortage",
    s.medicinesTracked > 0 ? ((2 * s.medicinesCritical + s.medicinesHigh) / s.medicinesTracked) * 2 : null,
    { tracked: s.medicinesTracked, critical: s.medicinesCritical, high: s.medicinesHigh },
  );

  // 2. Staffing: 70% from doctor shift coverage, 30% from unverified/incomplete records.
  push(
    "staffing_gap",
    s.doctorCoverage === null ? null : (1 - s.doctorCoverage) * 0.7 + clamp01((s.unverifiedShare ?? 0) * 2) * 0.3,
    {
      doctorCoveragePct: s.doctorCoverage === null ? null : Math.round(s.doctorCoverage * 100),
      unverifiedPct: s.unverifiedShare === null ? null : Math.round(s.unverifiedShare * 100),
    },
  );

  // 3. Projected demand vs OPD capacity: 0 at ≤60% of capacity, 1 at ≥120%.
  const ratio = s.projectedDailyFootfall === null ? null : s.projectedDailyFootfall / Math.max(1, s.opdCapacity);
  push("projected_demand", ratio === null ? null : (ratio - 0.6) / 0.6, {
    projectedDaily: s.projectedDailyFootfall,
    capacity: s.opdCapacity,
    loadPct: ratio === null ? null : Math.round(ratio * 100),
  });

  // 4. Bed utilisation of operational beds: 0 at ≤60%, 1 at 100%.
  const util = s.bedsOperational > 0 ? s.bedsOccupied / s.bedsOperational : null;
  push("bed_utilization", util === null ? null : (util - 0.6) / 0.4, {
    occupied: s.bedsOccupied,
    operational: s.bedsOperational,
    utilizationPct: util === null ? null : Math.round(util * 100),
  });

  // 5. Essential diagnostics interrupted (limited counts half).
  push(
    "diagnostics",
    s.essentialDiagnostics > 0 ? (s.essentialUnavailable + 0.5 * s.essentialLimited) / s.essentialDiagnostics : null,
    { essential: s.essentialDiagnostics, unavailable: s.essentialUnavailable, limited: s.essentialLimited },
  );

  // 6. Data freshness: 0 within 24h, 1 at ≥96h since the last update.
  push("data_freshness", s.hoursSinceUpdate === null ? 1 : (s.hoursSinceUpdate - 24) / 72, {
    hoursSinceUpdate: s.hoursSinceUpdate === null ? null : Math.round(s.hoursSinceUpdate),
  });

  const score = Math.round(factors.reduce((a, f) => a + f.contribution, 0));
  const band = score >= RISK_BANDS.high ? "high" : score >= RISK_BANDS.medium ? "medium" : "low";
  return {
    score,
    band,
    factors: factors.sort((a, b) => b.contribution - a.contribution),
    missingData: factors.filter((f) => f.normalized === null).map((f) => f.key),
  };
}
