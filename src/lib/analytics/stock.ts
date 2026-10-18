import { STOCK_RULES } from "../config/rules";
import { addDays, diffDays } from "../dates";
import type { Point, Sufficiency } from "./forecast";

// Stock-out prediction. Usable stock = non-expired batch quantity. A day-by-day
// simulation consumes projected demand First-Expiry-First-Out, removes batches
// as they expire and adds scheduled deliveries on their expected date.

export interface BatchInput {
  id: string;
  batchNumber: string;
  quantity: number;
  expiryDate: string;
}

export interface DeliveryInput {
  quantity: number;
  expectedDate: string;
}

export type StockRisk =
  | "stock_out"
  | "critical"
  | "high"
  | "low"
  | "ok"
  | "no_consumption"
  | "insufficient_data";

export interface Reason {
  key: string;
  params?: Record<string, string | number>;
}

export interface StockAssessment {
  usable: number;
  expired: number;
  nearExpiry: number;
  /** Quantity projected to expire before it can be consumed */
  projectedWastage: number;
  dailyDemand: number | null;
  demandSufficiency: Sufficiency;
  /** usable / daily demand; null when demand is zero or unknown */
  daysRemaining: number | null;
  projectedStockoutDate: string | null;
  daysUntilStockout: number | null;
  nextDelivery: DeliveryInput | null;
  deliveryBeforeStockout: boolean | null;
  safetyStock: number;
  leadTimeDays: number;
  risk: StockRisk;
  reasons: Reason[];
}

export interface StockInput {
  today: string;
  batches: BatchInput[];
  dailyDemand: number | null;
  demandSufficiency: Sufficiency;
  safetyStock: number;
  leadTimeDays: number;
  deliveries: DeliveryInput[];
  horizonDays?: number;
}

export const RISK_ORDER: Record<StockRisk, number> = {
  stock_out: 0,
  critical: 1,
  high: 2,
  low: 3,
  insufficient_data: 4,
  ok: 5,
  no_consumption: 6,
};

export function usableQuantity(batches: BatchInput[], today: string, minShelfDays = 0): number {
  const cutoff = addDays(today, minShelfDays);
  return batches.filter((b) => b.expiryDate >= cutoff).reduce((a, b) => a + b.quantity, 0);
}

export function assessStock(input: StockInput): StockAssessment {
  const { today, batches, safetyStock, leadTimeDays } = input;
  const horizon = input.horizonDays ?? STOCK_RULES.projectionHorizonDays;
  const nearCutoff = addDays(today, STOCK_RULES.nearExpiryDays);

  const usable = usableQuantity(batches, today);
  const expired = batches.filter((b) => b.expiryDate < today).reduce((a, b) => a + b.quantity, 0);
  const nearExpiry = batches
    .filter((b) => b.expiryDate >= today && b.expiryDate <= nearCutoff)
    .reduce((a, b) => a + b.quantity, 0);
  const pending = input.deliveries
    .filter((d) => d.expectedDate >= today)
    .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
  const nextDelivery = pending[0] ?? null;

  const demandKnown = input.dailyDemand !== null && input.demandSufficiency !== "insufficient";
  const demand = demandKnown ? (input.dailyDemand as number) : null;
  const reasons: Reason[] = [];

  // --- simulation -----------------------------------------------------------
  let projectedStockoutDate: string | null = null;
  let projectedWastage = 0;
  if (demand !== null && demand > 0) {
    const sim = batches
      .filter((b) => b.expiryDate >= today && b.quantity > 0)
      .map((b) => ({ qty: b.quantity, expiry: b.expiryDate }));
    for (let i = 0; i < horizon; i++) {
      const date = addDays(today, i);
      for (const d of pending) if (d.expectedDate === date) sim.push({ qty: d.quantity, expiry: "9999-12-31" });
      // expire
      for (const b of sim) {
        if (b.expiry < date && b.qty > 0) {
          projectedWastage += b.qty;
          b.qty = 0;
        }
      }
      sim.sort((a, b) => a.expiry.localeCompare(b.expiry));
      let need = demand;
      for (const b of sim) {
        if (need <= 0) break;
        const take = Math.min(b.qty, need);
        b.qty -= take;
        need -= take;
      }
      if (need > 1e-9 && projectedStockoutDate === null) {
        projectedStockoutDate = date;
        break;
      }
    }
  }
  const daysUntilStockout = projectedStockoutDate ? diffDays(today, projectedStockoutDate) : null;
  const daysRemaining = demand && demand > 0 ? Math.round((usable / demand) * 10) / 10 : null;
  const deliveryBeforeStockout =
    nextDelivery && projectedStockoutDate ? nextDelivery.expectedDate <= projectedStockoutDate : nextDelivery ? true : null;

  // --- classification -------------------------------------------------------
  let risk: StockRisk;
  if (usable <= 0) {
    risk = "stock_out";
    reasons.push({ key: "stock.reason.noUsableStock", params: { expired } });
  } else if (demand === null) {
    risk = "insufficient_data";
    reasons.push({ key: "stock.reason.insufficientHistory" });
  } else if (demand === 0) {
    risk = "no_consumption";
    reasons.push({ key: "stock.reason.noConsumption" });
  } else if (daysUntilStockout !== null && daysUntilStockout <= leadTimeDays) {
    risk = "critical";
    reasons.push({ key: "stock.reason.stockoutWithinLead", params: { days: daysUntilStockout, lead: leadTimeDays } });
  } else if (daysUntilStockout !== null && daysUntilStockout <= leadTimeDays + STOCK_RULES.highRiskBufferDays) {
    risk = "high";
    reasons.push({ key: "stock.reason.stockoutSoon", params: { days: daysUntilStockout, lead: leadTimeDays } });
  } else if (usable < safetyStock) {
    risk = "low";
    reasons.push({ key: "stock.reason.belowSafety", params: { usable, safety: safetyStock } });
  } else {
    risk = "ok";
  }

  if (nextDelivery && (risk === "critical" || risk === "high" || risk === "low")) {
    reasons.push({
      key: deliveryBeforeStockout ? "stock.reason.deliveryInTime" : "stock.reason.deliveryTooLate",
      params: { date: nextDelivery.expectedDate, qty: nextDelivery.quantity },
    });
  }
  if (expired > 0) reasons.push({ key: "stock.reason.expiredOnShelf", params: { expired } });
  if (projectedWastage > 0) reasons.push({ key: "stock.reason.projectedWastage", params: { qty: Math.round(projectedWastage) } });

  return {
    usable,
    expired,
    nearExpiry,
    projectedWastage: Math.round(projectedWastage),
    dailyDemand: demand === null ? null : Math.round(demand * 10) / 10,
    demandSufficiency: input.demandSufficiency,
    daysRemaining,
    projectedStockoutDate,
    daysUntilStockout,
    nextDelivery,
    deliveryBeforeStockout,
    safetyStock,
    leadTimeDays,
    risk,
    reasons,
  };
}

export interface DailyMovement {
  date: string;
  issued: number; // positive units issued
  net: number; // signed net movement of all transaction types
}

/**
 * Build the consumption history used for forecasting from daily ledger
 * movements. Days the shelf was empty are excluded ("censored"): zero issues
 * on a stocked-out day is unmet demand, not zero demand.
 */
export function consumptionSeries(
  movements: DailyMovement[],
  currentTotalStock: number,
  firstStockedDate: string | null,
  lastDate: string,
  windowDays: number,
): { series: Point[]; censoredDays: number } {
  const byDate = new Map(movements.map((m) => [m.date, m]));
  const start = addDays(lastDate, -(windowDays - 1));
  const from = firstStockedDate && firstStockedDate > start ? firstStockedDate : start;
  if (from > lastDate) return { series: [], censoredDays: 0 };

  // Walk backwards from the current balance to get each day's closing balance.
  // `currentTotalStock` is the balance now (after any movements after lastDate).
  const afterNet = movements.filter((m) => m.date > lastDate).reduce((a, m) => a + m.net, 0);
  let closing = currentTotalStock - afterNet;
  const out: Point[] = [];
  let censored = 0;
  for (let d = lastDate; d >= from; d = addDays(d, -1)) {
    const m = byDate.get(d);
    const net = m?.net ?? 0;
    const opening = closing - net;
    const issued = m?.issued ?? 0;
    const receivedToday = net + issued > 0;
    if (opening <= 0 && issued === 0 && !receivedToday) {
      censored++;
    } else {
      out.push({ date: d, value: issued });
    }
    closing = opening;
  }
  return { series: out.reverse(), censoredDays: censored };
}
