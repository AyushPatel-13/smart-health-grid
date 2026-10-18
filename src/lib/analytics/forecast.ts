import { FORECAST_RULES } from "../config/rules";
import { addDays, weekday } from "../dates";

// Explainable short-horizon forecasting for daily series (patient footfall and
// medicine consumption). Two candidate methods are evaluated on a hold-out
// window against a naive 7-day rolling-mean baseline; the one with the lower
// measured error is used. Nothing is claimed without a measurement.

export interface Point {
  date: string;
  value: number;
}

export interface ForecastPoint {
  date: string;
  value: number;
  lower: number;
  upper: number;
}

export type Sufficiency = "sufficient" | "limited" | "insufficient";
export type ForecastMethod = "weekday_weighted" | "rolling_mean_7" | "none";

export interface Backtest {
  testDays: number;
  method: ForecastMethod;
  mae: number;
  baselineMethod: "rolling_mean_7";
  baselineMae: number;
  /** Weighted absolute percentage error, null when actuals sum to zero */
  wape: number | null;
  /** % reduction in MAE vs baseline (negative = worse) */
  improvementPct: number | null;
}

export interface ForecastResult {
  method: ForecastMethod;
  sufficiency: Sufficiency;
  historyPoints: number;
  horizonDays: number;
  start: string | null;
  forecast: ForecastPoint[];
  /** Mean of forecast values (units/day) or null if no forecast */
  meanDaily: number | null;
  backtest: Backtest | null;
  /** i18n keys describing limitations of this forecast */
  limitations: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Weekday multipliers (value / overall mean); 1 where there is too little data. */
export function weekdayIndex(history: Point[]): number[] {
  const overall = mean(history.map((p) => p.value));
  const buckets: number[][] = [[], [], [], [], [], [], []];
  for (const p of history) buckets[weekday(p.date)].push(p.value);
  return buckets.map((b) => (b.length >= 2 && overall > 0 ? mean(b) / overall : 1));
}

interface Fitted {
  predict: (date: string) => number;
  residualStd: number;
}

function fitRollingMean(history: Point[]): Fitted {
  const last = history.slice(-7).map((p) => p.value);
  const level = mean(last);
  return { predict: () => level, residualStd: std(last) };
}

function fitWeekdayWeighted(history: Point[]): Fitted {
  const window = history.slice(-56);
  const idx = weekdayIndex(window);
  const recent = window.slice(-28);
  let wSum = 0;
  let vSum = 0;
  recent.forEach((p, i) => {
    const age = recent.length - 1 - i;
    const w = FORECAST_RULES.decay ** age;
    const deseason = idx[weekday(p.date)] > 0 ? p.value / idx[weekday(p.date)] : p.value;
    wSum += w;
    vSum += w * deseason;
  });
  const level = wSum ? vSum / wSum : 0;
  const residuals = recent.map((p) => p.value - level * idx[weekday(p.date)]);
  return { predict: (date) => level * idx[weekday(date)], residualStd: std(residuals) };
}

function mae(fit: Fitted, actual: Point[]): number {
  return mean(actual.map((p) => Math.abs(fit.predict(p.date) - p.value)));
}

/**
 * Forecast the next `horizon` days after `lastObservedDate`.
 * `history` must be sorted ascending; gaps (missing days) are allowed and are
 * simply not used — they are never treated as zero.
 */
export function forecastSeries(
  history: Point[],
  lastObservedDate: string,
  horizon: number = FORECAST_RULES.horizonDays,
): ForecastResult {
  const n = history.length;
  const limitations: string[] = [];
  const start = addDays(lastObservedDate, 1);

  if (n < FORECAST_RULES.minPointsForForecast) {
    return {
      method: "none",
      sufficiency: "insufficient",
      historyPoints: n,
      horizonDays: horizon,
      start: null,
      forecast: [],
      meanDaily: null,
      backtest: null,
      limitations: ["forecast.limit.insufficientHistory"],
    };
  }

  let method: ForecastMethod = "rolling_mean_7";
  let backtest: Backtest | null = null;
  const sufficiency: Sufficiency = n >= FORECAST_RULES.minPointsForSeasonal ? "sufficient" : "limited";

  if (sufficiency === "limited") {
    limitations.push("forecast.limit.shortHistory");
  } else {
    method = "weekday_weighted";
  }

  if (n >= FORECAST_RULES.minPointsForBacktest) {
    const testDays = FORECAST_RULES.backtestDays;
    const train = history.slice(0, n - testDays);
    const test = history.slice(n - testDays);
    const baseMae = mae(fitRollingMean(train), test);
    const seasonalMae = mae(fitWeekdayWeighted(train), test);
    method = seasonalMae <= baseMae ? "weekday_weighted" : "rolling_mean_7";
    const chosenMae = method === "weekday_weighted" ? seasonalMae : baseMae;
    const actualSum = test.reduce((a, p) => a + Math.abs(p.value), 0);
    backtest = {
      testDays,
      method,
      mae: round1(chosenMae),
      baselineMethod: "rolling_mean_7",
      baselineMae: round1(baseMae),
      wape: actualSum > 0 ? Math.round((chosenMae * testDays * 1000) / actualSum) / 10 : null,
      improvementPct: baseMae > 0 ? Math.round(((baseMae - chosenMae) / baseMae) * 1000) / 10 : null,
    };
    if (method === "rolling_mean_7") limitations.push("forecast.limit.baselineBetter");
  } else {
    limitations.push("forecast.limit.noBacktest");
  }

  const fit = method === "weekday_weighted" ? fitWeekdayWeighted(history) : fitRollingMean(history);
  const spread = FORECAST_RULES.intervalZ * fit.residualStd;
  const forecast: ForecastPoint[] = [];
  for (let i = 0; i < horizon; i++) {
    const date = addDays(start, i);
    const value = Math.max(0, fit.predict(date));
    forecast.push({
      date,
      value: round1(value),
      lower: round1(Math.max(0, value - spread)),
      upper: round1(value + spread),
    });
  }
  const meanDaily = mean(forecast.map((f) => f.value));
  if (meanDaily === 0) limitations.push("forecast.limit.zeroDemand");
  if (fit.residualStd > 0 && meanDaily > 0 && fit.residualStd / meanDaily > 0.5) {
    limitations.push("forecast.limit.highVariability");
  }

  return {
    method,
    sufficiency,
    historyPoints: n,
    horizonDays: horizon,
    start,
    forecast,
    meanDaily: round1(meanDaily),
    backtest,
    limitations,
  };
}

/**
 * Detect an unusual increase of the latest value vs. the preceding baseline.
 * Requires at least 14 baseline points to avoid flagging noise.
 */
export function detectSpike(
  history: Point[],
  sigma: number,
  ratio: number,
  baselineDays: number,
): { isSpike: boolean; latest: Point | null; baselineMean: number; baselineStd: number; ratio: number | null } {
  if (history.length < 15) {
    return { isSpike: false, latest: history.at(-1) ?? null, baselineMean: 0, baselineStd: 0, ratio: null };
  }
  const latest = history[history.length - 1];
  const base = history.slice(-(baselineDays + 1), -1);
  // Compare against same-weekday-adjusted expectation so Mondays aren't spikes.
  const idx = weekdayIndex(base);
  const deseason = base.map((p) => p.value / (idx[weekday(p.date)] || 1));
  const m = mean(deseason) * (idx[weekday(latest.date)] || 1);
  const s = std(deseason) * (idx[weekday(latest.date)] || 1);
  const r = m > 0 ? latest.value / m : null;
  const isSpike = m > 0 && latest.value > m + sigma * s && (r ?? 0) >= ratio;
  return { isSpike, latest, baselineMean: round1(m), baselineStd: round1(s), ratio: r === null ? null : Math.round(r * 100) / 100 };
}
