import { REDISTRIBUTION_RULES as R } from "../config/rules";
import { addDays, diffDays } from "../dates";
import { estimateTransit, recipientNeed, type RecommendedBatch, type StockPosition } from "./redistribution";
import type { StockRisk } from "./stock";

// Emergency-borrowing decision engine (deterministic, auditable).
//
// For each facility/medicine at risk it decides between:
//   A normal_replenishment — routine warehouse supply is sufficient/timely
//   B emergency_borrow     — a nearby lender can safely cover the gap until a
//                            scheduled delivery arrives
//   C emergency_borrow_plus_replenishment — borrow what is safely lendable AND
//                            raise a linked warehouse replenishment
//   D escalate             — no safe lender exists; district action needed
//
// Safe lendable quantity (per lender) =
//   min( transferable stock with ≥ minShelfDays shelf life,
//        usable − already committed outgoing − safety stock
//               − projected own demand over its replenishment lead time )
// Only the SAME medicine (identical id ⇒ identical unit) is ever lent; batch
// numbers and expiry dates are preserved, never pooled.

export type DistributionDecision = "normal_replenishment" | "emergency_borrow" | "emergency_borrow_plus_replenishment" | "escalate";
export type Urgency = "critical" | "high" | "medium" | "low";

export interface LenderOption {
  facilityId: string;
  facilityName: string;
  usable: number;
  transferable: number;
  committed: number;
  safetyStock: number;
  dailyDemand: number;
  leadTimeDays: number;
  projectedOwnDemand: number;
  lendable: number;
  distanceKm: number | null;
  transitHours: number | null;
  batches: RecommendedBatch[];
  plannedQuantity: number;
}

export interface Reason {
  key: string;
  params?: Record<string, string | number>;
}

export interface DistributionRecommendation {
  key: string;
  medicineId: string;
  medicineName: string;
  unit: string;
  recipient: {
    facilityId: string;
    facilityName: string;
    usable: number;
    dailyDemand: number;
    risk: StockRisk;
    daysUntilStockout: number | null;
    daysRemaining: number | null;
    leadTimeDays: number;
    nextDelivery: { date: string; quantity: number } | null;
  };
  requiredQuantity: number;
  decision: DistributionDecision;
  urgency: Urgency;
  lenders: LenderOption[];
  chosen: LenderOption | null;
  proposedQuantity: number;
  replenishmentQuantity: number;
  reasons: Reason[];
  limitations: Reason[];
}

const URGENCY: Partial<Record<StockRisk, Urgency>> = { stock_out: "critical", critical: "high", high: "medium", low: "low" };

/** Safe lendable quantity for a candidate lender (see header). */
export function safeLendable(p: StockPosition, committed: number, today: string) {
  const demand = p.dailyDemand ?? 0;
  const cutoff = addDays(today, R.minShelfDays);
  const eligible = p.batches.filter((b) => b.expiryDate >= cutoff && b.quantity > 0).sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  const transferable = eligible.reduce((a, b) => a + b.quantity, 0);
  const projectedOwnDemand = Math.ceil(demand * p.leadTimeDays);
  const lendable = Math.max(0, Math.min(transferable - committed, p.usable - committed - p.safetyStock - projectedOwnDemand));
  return { eligible, transferable, projectedOwnDemand, lendable };
}

/** FEFO batch plan the recipient can actually consume before expiry. */
function planBatches(eligible: StockPosition["batches"], qty: number, recipientDemand: number, recipientUsable: number, transitDays: number, today: string) {
  const picked: RecommendedBatch[] = [];
  let left = qty;
  let cumulative = recipientUsable;
  for (const b of eligible) {
    if (left <= 0) break;
    const daysToExpiry = diffDays(today, b.expiryDate) - transitDays;
    const consumable = Math.floor(recipientDemand * daysToExpiry) - cumulative;
    const take = Math.min(b.quantity, left, Math.max(0, consumable));
    if (take <= 0) continue;
    picked.push({ batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: take });
    left -= take;
    cumulative += take;
  }
  return picked;
}

export function decideDistribution(
  positions: StockPosition[],
  committedBy: Map<string, number>,
  today: string,
): DistributionRecommendation[] {
  const out: DistributionRecommendation[] = [];
  for (const p of positions) {
    const urgency = URGENCY[p.risk];
    if (!urgency) continue;
    const demand = p.dailyDemand ?? 0;
    if (demand <= 0 && p.risk !== "stock_out") continue;

    const { need, window, incoming } = recipientNeed(p, today);
    const nextDelivery = [...p.deliveries].filter((d) => d.expectedDate >= today).sort((a, b) => a.expectedDate.localeCompare(b.expectedDate))[0] ?? null;
    const stockoutDate = p.daysUntilStockout !== null ? addDays(today, p.daysUntilStockout) : null;
    const deliveryInTime = !!nextDelivery && (!stockoutDate || nextDelivery.expectedDate <= stockoutDate);
    const reasons: Reason[] = [];
    const limitations: Reason[] = [];
    if (p.risk === "stock_out") reasons.push({ key: "distribution.reason.stockOut" });
    else if (p.daysUntilStockout !== null) reasons.push({ key: "distribution.reason.stockoutIn", params: { days: p.daysUntilStockout, lead: p.leadTimeDays } });
    if (p.risk === "low") reasons.push({ key: "distribution.reason.belowSafety", params: { usable: p.usable, safety: p.safetyStock } });
    if (nextDelivery) {
      reasons.push({
        key: deliveryInTime ? "distribution.reason.deliveryInTime" : "distribution.reason.deliveryLate",
        params: { date: nextDelivery.expectedDate, qty: nextDelivery.quantity },
      });
    } else reasons.push({ key: "distribution.reason.noDelivery" });
    if (p.dailyDemand === null) limitations.push({ key: "distribution.limit.noDemand" });

    const base = {
      key: `${p.medicineId}:${p.facilityId}`,
      medicineId: p.medicineId,
      medicineName: p.medicineName,
      unit: p.unit,
      recipient: {
        facilityId: p.facilityId,
        facilityName: p.facilityName,
        usable: p.usable,
        dailyDemand: demand,
        risk: p.risk,
        daysUntilStockout: p.daysUntilStockout,
        daysRemaining: demand > 0 ? Math.round((p.usable / demand) * 10) / 10 : null,
        leadTimeDays: p.leadTimeDays,
        nextDelivery: nextDelivery ? { date: nextDelivery.expectedDate, quantity: nextDelivery.quantity } : null,
      },
      urgency,
      limitations,
    };
    const routineQty = Math.max(0, Math.ceil(demand * (p.leadTimeDays + 14) + p.safetyStock - p.usable - incoming));

    // A: routine supply is adequate (only below safety stock, or a timely delivery exists).
    if (p.risk === "low" || (p.risk === "high" && deliveryInTime)) {
      if (routineQty <= 0 && p.risk !== "low") continue;
      out.push({
        ...base,
        requiredQuantity: Math.max(need, routineQty),
        decision: "normal_replenishment",
        lenders: [],
        chosen: null,
        proposedQuantity: 0,
        replenishmentQuantity: Math.max(routineQty, 1),
        reasons: [...reasons, { key: "distribution.reason.routineSufficient" }],
      });
      continue;
    }

    const required = Math.max(need, p.risk === "stock_out" ? Math.ceil(demand * Math.max(window, 3)) : 0);
    if (required <= 0) continue;
    const minQty = Math.max(1, Math.ceil(demand * R.minTransferDaysOfDemand));

    const lenders: LenderOption[] = positions
      .filter((d) => d.medicineId === p.medicineId && d.facilityId !== p.facilityId && d.dailyDemand !== null)
      .filter((d) => d.risk === "ok" || d.risk === "no_consumption")
      .map((d) => {
        const committed = committedBy.get(`${d.facilityId}:${d.medicineId}`) ?? 0;
        const s = safeLendable(d, committed, today);
        const t = estimateTransit(p, d);
        const transitDays = Math.ceil((t.hours ?? 24) / 24);
        const batches = planBatches(s.eligible, Math.min(required, s.lendable), demand, p.usable, transitDays, today);
        return {
          facilityId: d.facilityId,
          facilityName: d.facilityName,
          usable: d.usable,
          transferable: s.transferable,
          committed,
          safetyStock: d.safetyStock,
          dailyDemand: d.dailyDemand ?? 0,
          leadTimeDays: d.leadTimeDays,
          projectedOwnDemand: s.projectedOwnDemand,
          lendable: s.lendable,
          distanceKm: t.km,
          transitHours: t.hours,
          batches,
          plannedQuantity: batches.reduce((a, b) => a + b.quantity, 0),
        };
      })
      .filter((l) => l.plannedQuantity >= minQty)
      .sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || b.plannedQuantity - a.plannedQuantity)
      .slice(0, 3);

    if (lenders.some((l) => l.distanceKm === null)) limitations.push({ key: "distribution.limit.noCoordinates" });
    if (lenders.length) limitations.push({ key: "distribution.limit.transitEstimate" });

    if (!lenders.length) {
      out.push({
        ...base,
        requiredQuantity: required,
        decision: "escalate",
        lenders: [],
        chosen: null,
        proposedQuantity: 0,
        replenishmentQuantity: Math.max(required, routineQty),
        reasons: [...reasons, { key: "distribution.reason.noLender" }],
      });
      continue;
    }

    const chosen = lenders[0];
    const proposed = Math.min(required, chosen.plannedQuantity);
    const covers = proposed >= required;
    // B when the loan fully bridges the gap until a scheduled delivery; otherwise C.
    const decision: DistributionDecision = covers && nextDelivery ? "emergency_borrow" : "emergency_borrow_plus_replenishment";
    const replenishmentQuantity = decision === "emergency_borrow" ? 0 : Math.max(required - proposed, routineQty - proposed, 1);
    out.push({
      ...base,
      requiredQuantity: required,
      decision,
      lenders,
      chosen,
      proposedQuantity: proposed,
      replenishmentQuantity,
      reasons: [
        ...reasons,
        { key: "distribution.reason.lender", params: { name: chosen.facilityName, lendable: chosen.lendable, km: chosen.distanceKm ?? "—" } },
        ...(covers ? [] : [{ key: "distribution.reason.partial", params: { proposed, required } }]),
        ...(decision === "emergency_borrow_plus_replenishment" ? [{ key: "distribution.reason.linkedReplenishment", params: { qty: replenishmentQuantity } }] : []),
      ],
    });
  }
  const rank: Record<Urgency, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort((a, b) => rank[a.urgency] - rank[b.urgency] || (a.recipient.daysUntilStockout ?? 0) - (b.recipient.daysUntilStockout ?? 0));
}
