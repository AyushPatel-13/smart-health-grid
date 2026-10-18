import { REDISTRIBUTION_RULES as R, STOCK_RULES } from "../config/rules";
import { addDays, diffDays } from "../dates";
import { estimateTransit, type StockPosition } from "./redistribution";

// Near-expiry optimizer. For each facility/medicine, a FEFO simulation
// determines how much of each near-expiry batch will be consumed locally
// before it expires; the remainder is "at risk" of wastage. At-risk stock is
// matched to nearby centres that can consume it before expiry.
//
// Safeguards: only the exact batch/medicine; batches with less than
// minShelfDays left are flagged for local use / write-off planning but never
// moved; the donor keeps safety stock and all quantity it can itself use;
// the recipient must be able to consume the quantity before expiry and must
// not become overstocked. Every move still requires administrator approval.

export interface ExpiryBatchRisk {
  facilityId: string;
  facilityName: string;
  medicineId: string;
  medicineName: string;
  unit: string;
  batchNumber: string;
  expiryDate: string;
  daysToExpiry: number;
  quantity: number;
  usedLocally: number;
  atRisk: number;
  movable: boolean;
}

export interface ExpiryRecommendation {
  key: string;
  risk: ExpiryBatchRisk;
  recipientId: string;
  recipientName: string;
  recipientDemand: number;
  recipientUsable: number;
  recipientCanConsume: number;
  quantity: number;
  distanceKm: number | null;
  transitHours: number | null;
  donorRemainingAfter: number;
  donorSafety: number;
  reasons: { key: string; params?: Record<string, string | number> }[];
}

/** FEFO simulation of local consumption for one facility/medicine. */
export function batchExpiryRisk(p: StockPosition, today: string): ExpiryBatchRisk[] {
  const demand = p.dailyDemand ?? 0;
  const cutoff = addDays(today, STOCK_RULES.nearExpiryDays);
  const batches = p.batches.filter((b) => b.expiryDate >= today && b.quantity > 0).sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
  const out: ExpiryBatchRisk[] = [];
  let consumedBefore = 0;
  for (const b of batches) {
    const days = diffDays(today, b.expiryDate);
    const capacity = Math.max(0, Math.floor(demand * (days + 1)) - consumedBefore);
    const used = Math.min(b.quantity, capacity);
    consumedBefore += used;
    const atRisk = b.quantity - used;
    if (b.expiryDate <= cutoff && atRisk > 0) {
      out.push({
        facilityId: p.facilityId,
        facilityName: p.facilityName,
        medicineId: p.medicineId,
        medicineName: p.medicineName,
        unit: p.unit,
        batchNumber: b.batchNumber,
        expiryDate: b.expiryDate,
        daysToExpiry: days,
        quantity: b.quantity,
        usedLocally: used,
        atRisk,
        movable: days >= R.minShelfDays,
      });
    }
  }
  return out;
}

export function expiryOptimizer(positions: StockPosition[], committedBy: Map<string, number>, today: string) {
  const risks = positions.flatMap((p) => batchExpiryRisk(p, today));
  const recs: ExpiryRecommendation[] = [];
  const recipientTaken = new Map<string, number>();

  for (const risk of risks.filter((r) => r.movable)) {
    const donor = positions.find((p) => p.facilityId === risk.facilityId && p.medicineId === risk.medicineId)!;
    const committed = committedBy.get(`${donor.facilityId}:${donor.medicineId}`) ?? 0;
    let budget = Math.min(risk.atRisk, Math.max(0, donor.usable - committed - donor.safetyStock));
    if (budget <= 0) continue;

    const candidates = positions
      .filter((p) => p.medicineId === risk.medicineId && p.facilityId !== risk.facilityId && (p.dailyDemand ?? 0) > 0)
      .map((p) => {
        const t = estimateTransit(donor, p);
        const transitDays = Math.ceil((t.hours ?? 24) / 24);
        const demand = p.dailyDemand ?? 0;
        // Recipient stock that expires before this batch is consumed first.
        const earlier = p.batches.filter((b) => b.expiryDate >= today && b.expiryDate <= risk.expiryDate).reduce((a, b) => a + b.quantity, 0);
        const taken = recipientTaken.get(`${p.facilityId}:${p.medicineId}`) ?? 0;
        const canConsume = Math.max(0, Math.floor(demand * (risk.daysToExpiry - transitDays)) - earlier - taken);
        const notOverstocked = p.usable + taken < demand * (p.leadTimeDays + 30);
        return { p, t, demand, canConsume, notOverstocked };
      })
      .filter((c) => c.notOverstocked && c.canConsume >= Math.max(5, Math.ceil(c.demand)))
      .sort((a, b) => (a.t.km ?? 1e9) - (b.t.km ?? 1e9));

    for (const c of candidates.slice(0, 2)) {
      if (budget <= 0) break;
      const qty = Math.min(budget, c.canConsume);
      if (qty < 5) continue;
      budget -= qty;
      recipientTaken.set(`${c.p.facilityId}:${c.p.medicineId}`, (recipientTaken.get(`${c.p.facilityId}:${c.p.medicineId}`) ?? 0) + qty);
      recs.push({
        key: `expiry:${risk.medicineId}:${risk.facilityId}:${c.p.facilityId}:${risk.batchNumber}`,
        risk,
        recipientId: c.p.facilityId,
        recipientName: c.p.facilityName,
        recipientDemand: c.demand,
        recipientUsable: c.p.usable,
        recipientCanConsume: c.canConsume,
        quantity: qty,
        distanceKm: c.t.km,
        transitHours: c.t.hours,
        donorRemainingAfter: donor.usable - qty,
        donorSafety: donor.safetyStock,
        reasons: [
          { key: "expiry.reason.atRisk", params: { qty: risk.atRisk, batch: risk.batchNumber, date: risk.expiryDate } },
          { key: "expiry.reason.recipientUse", params: { name: c.p.facilityName, demand: c.demand, can: c.canConsume } },
          { key: "expiry.reason.donorSafe", params: { after: donor.usable - qty, safety: donor.safetyStock } },
        ],
      });
    }
  }
  return { risks, recs };
}
