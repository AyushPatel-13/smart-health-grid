import type { Tone } from "./primitives";
import type { StockRisk } from "@/lib/analytics/stock";

export const severityTone: Record<string, Tone> = { critical: "critical", warning: "warning", info: "info" };

export const stockRiskTone: Record<StockRisk, Tone> = {
  stock_out: "critical",
  critical: "critical",
  high: "warning",
  low: "warning",
  ok: "success",
  no_consumption: "neutral",
  insufficient_data: "neutral",
};

export const riskBandTone: Record<string, Tone> = { high: "critical", medium: "warning", low: "success" };

export const diagTone: Record<string, Tone> = { available: "success", limited: "warning", unavailable: "critical" };

export const alertStatusTone: Record<string, Tone> = { open: "critical", acknowledged: "warning", resolved: "success" };

export const transferTone: Record<string, Tone> = {
  pending: "warning",
  approved: "info",
  rejected: "neutral",
  completed: "success",
  cancelled: "neutral",
  dispatched: "info",
  received: "teal",
  replenishment_pending: "warning",
  closed: "success",
  failed: "critical",
};

export const attendanceTone: Record<string, Tone> = {
  present: "success",
  absent_verified: "critical",
  approved_leave: "info",
  unverified: "warning",
  incomplete: "warning",
  pending: "neutral",
  scheduled: "neutral",
};

export const opStatusTone: Record<string, Tone> = { operational: "success", limited: "warning", non_operational: "critical" };

export function utilizationTone(u: number | null): Tone {
  if (u === null) return "neutral";
  if (u >= 1) return "critical";
  if (u >= 0.9) return "warning";
  return "success";
}
