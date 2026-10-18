import { REDISTRIBUTION_RULES as R } from "../config/rules";
import { addDays, diffDays } from "../dates";
import type { BatchInput, DeliveryInput, StockRisk } from "./stock";

// Explainable redistribution: match facilities projected to run short with
// facilities holding surplus of the same medicine. Hard guarantees:
//   * only batches with ≥ minShelfDays remaining shelf life are moved,
//   * a donor never drops below safety stock + its own projected demand
//     over (lead time + buffer),
//   * a batch is only sent if the recipient can consume it before expiry.
// Recommendations are advisory — a district admin must approve every transfer.

export interface StockPosition {
  facilityId: string;
  facilityName: string;
  medicineId: string;
  medicineName: string;
  unit: string;
  latitude: number | null;
  longitude: number | null;
  batches: BatchInput[];
  usable: number;
  dailyDemand: number | null;
  safetyStock: number;
  leadTimeDays: number;
  risk: StockRisk;
  daysUntilStockout: number | null;
  deliveries: DeliveryInput[];
}

export interface RecommendedBatch {
  batchNumber: string;
  expiryDate: string;
  quantity: number;
}

export interface Recommendation {
  key: string;
  medicineId: string;
  medicineName: string;
  unit: string;
  quantity: number;
  batches: RecommendedBatch[];
  recipient: {
    facilityId: string;
    facilityName: string;
    usable: number;
    dailyDemand: number;
    risk: StockRisk;
    daysUntilStockout: number | null;
    need: number;
    coverWindowDays: number;
    incomingInWindow: number;
    daysOfStockBefore: number;
    daysOfStockAfter: number;
  };
  donor: {
    facilityId: string;
    facilityName: string;
    usable: number;
    transferable: number;
    reserve: number;
    surplus: number;
    safetyStock: number;
    remainingAfter: number;
    dailyDemand: number;
    daysOfStockAfter: number | null;
  };
  distanceKm: number | null;
  transitHours: number | null;
  reasons: { key: string; params?: Record<string, string | number> }[];
}

export function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function estimateTransit(a: StockPosition, b: StockPosition): { km: number | null; hours: number | null } {
  if (a.latitude == null || a.longitude == null || b.latitude == null || b.longitude == null) {
    return { km: null, hours: null };
  }
  const km = haversineKm({ lat: a.latitude, lon: a.longitude }, { lat: b.latitude, lon: b.longitude }) * R.roadFactor;
  return { km: Math.round(km * 10) / 10, hours: Math.round((km / R.averageSpeedKmh + R.handlingHours) * 10) / 10 };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Recipient need: stock required to bridge until supply resumes (the next
 * scheduled delivery if it lands inside lead time + buffer, otherwise the whole
 * window) plus safety stock, net of usable stock. A delivery that arrives
 * after the projected stock-out does not cancel the need — it shortens the
 * bridge.
 */
export function recipientNeed(p: StockPosition, today: string) {
  const demand = p.dailyDemand ?? 0;
  const window = p.leadTimeDays + R.recipientCoverBufferDays;
  const windowEnd = addDays(today, window);
  const inWindow = p.deliveries
    .filter((d) => d.expectedDate >= today && d.expectedDate <= windowEnd)
    .sort((a, b) => a.expectedDate.localeCompare(b.expectedDate));
  const incoming = inWindow.reduce((a, d) => a + d.quantity, 0);
  const bridge = inWindow.length ? Math.max(1, diffDays(today, inWindow[0].expectedDate)) : window;
  const need = Math.ceil(demand * bridge + p.safetyStock - p.usable);
  return { need: Math.max(0, need), window: bridge, incoming };
}

/** Donor's transferable surplus after keeping its reserve. */
export function donorSurplus(p: StockPosition, today: string) {
  const demand = p.dailyDemand ?? 0;
  const cutoff = addDays(today, R.minShelfDays);
  const eligible = p.batches.filter((b) => b.expiryDate >= cutoff && b.quantity > 0);
  const transferable = eligible.reduce((a, b) => a + b.quantity, 0);
  const reserve = p.safetyStock + Math.ceil(demand * (p.leadTimeDays + R.donorReserveBufferDays));
  // Reserve is held against ALL usable stock, but only eligible batches can move.
  const surplus = Math.max(0, Math.min(transferable, p.usable - reserve));
  return { transferable, reserve, surplus, eligible };
}

export function recommendTransfers(positions: StockPosition[], today: string): Recommendation[] {
  const byMedicine = new Map<string, StockPosition[]>();
  for (const p of positions) {
    const list = byMedicine.get(p.medicineId) ?? [];
    list.push(p);
    byMedicine.set(p.medicineId, list);
  }

  const out: Recommendation[] = [];
  for (const list of byMedicine.values()) {
    const recipients = list
      .filter((p) => (p.risk === "stock_out" || p.risk === "critical" || p.risk === "high") && (p.dailyDemand ?? 0) > 0)
      .sort((a, b) => (a.daysUntilStockout ?? 0) - (b.daysUntilStockout ?? 0));
    if (!recipients.length) continue;

    // Donors: known demand (including zero), not themselves at risk.
    const donorState = new Map<string, { surplus: number; batches: { b: BatchInput; left: number }[] }>();
    for (const p of list) {
      if (p.dailyDemand === null) continue;
      if (p.risk === "stock_out" || p.risk === "critical" || p.risk === "high" || p.risk === "low") continue;
      const s = donorSurplus(p, today);
      if (s.surplus <= 0) continue;
      donorState.set(p.facilityId, {
        surplus: s.surplus,
        batches: [...s.eligible]
          .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
          .map((b) => ({ b, left: b.quantity })),
      });
    }

    for (const rcp of recipients) {
      const { need, window, incoming } = recipientNeed(rcp, today);
      const demand = rcp.dailyDemand ?? 0;
      const minQty = Math.max(1, Math.ceil(demand * R.minTransferDaysOfDemand));
      if (need < minQty) continue;

      // Rank donors: those holding surplus that expires within 90 days first
      // (moving it prevents wastage), then nearest first.
      const soon = addDays(today, 90);
      const expiresSoon = (st: { batches: { b: BatchInput; left: number }[] }) =>
        st.batches.some((x) => x.left > 0 && x.b.expiryDate <= soon) ? 0 : 1;
      const donors = list
        .filter((d) => d.facilityId !== rcp.facilityId && donorState.has(d.facilityId))
        .map((d) => ({ d, t: estimateTransit(rcp, d), st: donorState.get(d.facilityId)! }))
        .filter((x) => x.st.surplus >= minQty)
        .sort((a, b) => expiresSoon(a.st) - expiresSoon(b.st) || (a.t.km ?? 1e9) - (b.t.km ?? 1e9));

      let remainingNeed = need;
      let used = 0;
      for (const { d, t, st } of donors) {
        if (remainingNeed < minQty || used >= R.maxDonorsPerNeed) break;
        const transitDays = Math.ceil((t.hours ?? 24) / 24);
        let budget = Math.min(remainingNeed, st.surplus);
        const picked: RecommendedBatch[] = [];
        let cumulative = rcp.usable;
        for (const slot of st.batches) {
          if (budget <= 0) break;
          if (slot.left <= 0) continue;
          // Recipient must be able to consume this batch before it expires.
          const daysToExpiry = diffDays(today, slot.b.expiryDate) - transitDays;
          const consumable = Math.floor(demand * daysToExpiry) - cumulative;
          const take = Math.min(slot.left, budget, Math.max(0, consumable));
          if (take <= 0) continue;
          picked.push({ batchNumber: slot.b.batchNumber, expiryDate: slot.b.expiryDate, quantity: take });
          slot.left -= take;
          budget -= take;
          cumulative += take;
        }
        const qty = picked.reduce((a, b) => a + b.quantity, 0);
        if (qty < minQty) continue;

        const ds = donorSurplus(d, today);
        st.surplus -= qty;
        remainingNeed -= qty;
        used++;
        const donorDemand = d.dailyDemand ?? 0;
        const remainingAfter = d.usable - qty;
        const reasons: Recommendation["reasons"] = [
          {
            key: rcp.risk === "stock_out" ? "redistribution.reason.recipientStockOut" : "redistribution.reason.recipientShortage",
            params: { days: rcp.daysUntilStockout ?? 0, lead: rcp.leadTimeDays },
          },
          { key: "redistribution.reason.donorSurplus", params: { surplus: ds.surplus, reserve: ds.reserve } },
        ];
        if (picked.some((p) => diffDays(today, p.expiryDate) <= 90)) {
          reasons.push({ key: "redistribution.reason.reducesWastage" });
        }
        if (t.km !== null) reasons.push({ key: "redistribution.reason.nearest", params: { km: t.km } });

        out.push({
          key: `${rcp.medicineId}:${d.facilityId}:${rcp.facilityId}`,
          medicineId: rcp.medicineId,
          medicineName: rcp.medicineName,
          unit: rcp.unit,
          quantity: qty,
          batches: picked,
          recipient: {
            facilityId: rcp.facilityId,
            facilityName: rcp.facilityName,
            usable: rcp.usable,
            dailyDemand: demand,
            risk: rcp.risk,
            daysUntilStockout: rcp.daysUntilStockout,
            need,
            coverWindowDays: window,
            incomingInWindow: incoming,
            daysOfStockBefore: round1(rcp.usable / demand),
            daysOfStockAfter: round1((rcp.usable + qty) / demand),
          },
          donor: {
            facilityId: d.facilityId,
            facilityName: d.facilityName,
            usable: d.usable,
            transferable: ds.transferable,
            reserve: ds.reserve,
            surplus: ds.surplus,
            safetyStock: d.safetyStock,
            remainingAfter,
            dailyDemand: donorDemand,
            daysOfStockAfter: donorDemand > 0 ? round1(remainingAfter / donorDemand) : null,
          },
          distanceKm: t.km,
          transitHours: t.hours,
          reasons,
        });
      }
    }
  }
  return out.sort((a, b) => (a.recipient.daysUntilStockout ?? 0) - (b.recipient.daysUntilStockout ?? 0));
}
