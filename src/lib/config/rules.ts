// Transparent, configurable thresholds used by the alert rules, the stock
// projection, the facility risk score and the redistribution engine.
// Changing a value here changes behaviour everywhere — and the UI shows these
// values next to every score so decisions stay explainable.

export const STOCK_RULES = {
  /** Batches expiring within this many days are "near expiry". */
  nearExpiryDays: 60,
  /** Projection horizon for stock-out simulation. */
  projectionHorizonDays: 90,
  /** A stock-out within lead time + this buffer is "high" risk. */
  highRiskBufferDays: 7,
  /** History window used to estimate consumption. */
  consumptionWindowDays: 56,
};

export const FORECAST_RULES = {
  horizonDays: 7,
  /** Fewer points than this: no forecast is produced. */
  minPointsForForecast: 7,
  /** At least this many points: weekday-adjusted method is eligible. */
  minPointsForSeasonal: 21,
  /** At least this many points: hold-out backtest is run. */
  minPointsForBacktest: 28,
  backtestDays: 7,
  /** Exponential decay per day for the weighted level. */
  decay: 0.9,
  /** z-score for the reported prediction interval (80%). */
  intervalZ: 1.28,
};

export const ALERT_RULES = {
  bedWarningUtilization: 0.9,
  footfallSpikeSigma: 2,
  footfallSpikeRatio: 1.3,
  footfallBaselineDays: 28,
  staleFootfallDays: 2,
  staleBedHours: 48,
  staleDiagnosticDays: 7,
  staffingWindowDays: 7,
  /** Share of past shifts that are unverified/incomplete that triggers review. */
  attendanceReviewShare: 0.35,
};

export const REDISTRIBUTION_RULES = {
  /** Minimum remaining shelf life for transferable stock (matches SQL min_transfer_shelf_days()). */
  minShelfDays: 30,
  /** Recipient need covers lead time + this many days. */
  recipientCoverBufferDays: 7,
  /** Donor keeps safety stock + demand for its lead time + this many days. */
  donorReserveBufferDays: 14,
  /** Ignore transfers smaller than this many days of recipient demand. */
  minTransferDaysOfDemand: 2,
  maxDonorsPerNeed: 2,
  roadFactor: 1.3,
  averageSpeedKmh: 30,
  handlingHours: 1,
};

/** Facility risk score weights (sum = 100). */
export const RISK_WEIGHTS = {
  medicine_shortage: 30,
  staffing_gap: 20,
  projected_demand: 15,
  bed_utilization: 15,
  diagnostics: 15,
  data_freshness: 5,
} as const;

export type RiskFactorKey = keyof typeof RISK_WEIGHTS;

export const RISK_BANDS = { high: 45, medium: 25 };

/** Hourly batch appointment allocation. */
export const ALLOCATION_RULES = {
  /** Registration window length; configurable via SHG_ALLOCATION_WINDOW_MINUTES. */
  windowMinutes: Math.max(5, Math.min(24 * 60, Number(process.env.SHG_ALLOCATION_WINDOW_MINUTES ?? 60) || 60)),
  /** Centres farther than this (straight-line) are not considered. */
  maxDistanceKm: 30,
  /** Slots must start at least this long after the window cutoff to be requestable. */
  minLeadMinutes: 60,
  /** A window stuck in "processing" longer than this is retried. */
  staleProcessingMinutes: 10,
  maxAttempts: 5,
  /** Alternatives offered to waitlisted patients look ahead this many days. */
  alternativesDays: 3,
};

/** Doctor workload and redeployment. */
export const WORKFORCE_RULES = {
  /** Consultation hours each shift contributes to OPD capacity. */
  shiftConsultHours: { morning: 6, evening: 6, on_call: 4, night: 0 } as Record<string, number>,
  /** Scheduled shift windows (IST, 24h) for lateness and duty duration. */
  shiftHours: { morning: [8, 14], evening: [14, 20], night: [20, 32], on_call: [8, 20] } as Record<string, [number, number]>,
  /** Average OPD consultation minutes per patient (incl. documentation). */
  consultMinutes: 7,
  /** Only this share of doctor-hours is treated as safely usable for OPD. */
  safeUtilization: 0.85,
  /** Minimum doctors that must remain rostered at a donor facility per day. */
  minDoctorsPerDay: { PHC: 1, CHC: 2 } as Record<string, number>,
  /** Days ahead evaluated for workload and redeployment. */
  horizonDays: 3,
  lateGraceMinutes: 15,
};

/** Mobile attendance verification. */
export const ATTENDANCE_RULES = {
  defaultGeofenceM: 250,
  maxAccuracyM: 100,
  maxLocationAgeS: 120,
  /** A completed shift shorter than this share of the scheduled duration is flagged for review. */
  minDutyShare: 0.5,
};
