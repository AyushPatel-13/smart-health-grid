import { createHash } from "node:crypto";
import { haversineKm } from "../analytics/redistribution";

// Capacity-constrained, nearest-first batch allocation.
//
// POLICY (documented, deterministic):
//   * All requests for the same service + date + start time that arrived in a
//     registration window are allocated TOGETHER at the window cutoff, so
//     registration order never matters.
//   * Each patient's candidate list = eligible centres within the maximum
//     distance, sorted nearest-first (an explicitly preferred eligible centre,
//     if given, is tried first — patients are never forced away from a choice).
//   * Each centre ranks the patients competing for its slot nearest-first.
//   * Patient-proposing deferred acceptance (Gale–Shapley) produces a STABLE
//     assignment: no patient is left at a farther centre (or unallocated) while
//     a closer eligible centre gave a seat to someone farther from it, and no
//     slot is over-filled. With pure distance preferences this equals the
//     global "closest pair first" greedy, and is independent of input order.
//   * Ties at equal distance are broken by tieKey = sha256(windowId:requestId)
//     — a reproducible pseudo-random order unrelated to registration time.
//   * Unallocated patients are waitlisted and offered alternatives; nothing
//     is ever overbooked.

export interface AllocRequest {
  id: string;
  lat: number;
  lon: number;
  preferredFacilityId?: string | null;
  tieKey: string;
}

export interface AllocSlot {
  slotId: string;
  facilityId: string;
  lat: number;
  lon: number;
  /** Remaining capacity (capacity - already allocated). */
  remaining: number;
}

export interface Assignment {
  requestId: string;
  slotId: string;
  facilityId: string;
  distanceKm: number;
  preferenceRank: number; // 1 = patient's first choice (nearest unless preferred)
  rankAtFacility: number; // position among patients allocated to this slot
}

export interface Decision {
  requestId: string;
  facilityId: string | null;
  slotId: string | null;
  distanceKm: number | null;
  preferenceRank: number | null;
  outcome: "allocated" | "rejected_capacity" | "waitlisted";
  reason: string;
}

export interface AllocationResult {
  assignments: Assignment[];
  waitlisted: { requestId: string; reason: "no_capacity" | "no_eligible_centre" }[];
  decisions: Decision[];
}

export function tieKey(windowId: string, requestId: string): string {
  return createHash("sha256").update(`${windowId}:${requestId}`).digest("hex");
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function allocate(requests: AllocRequest[], slots: AllocSlot[], opts: { maxDistanceKm: number }): AllocationResult {
  // Deterministic processing order regardless of input order.
  const reqs = [...requests].sort((a, b) => a.tieKey.localeCompare(b.tieKey));
  const open = slots.filter((s) => s.remaining > 0);

  const prefs = new Map<string, { slot: AllocSlot; km: number }[]>();
  for (const r of reqs) {
    const list = open
      .map((slot) => ({ slot, km: round2(haversineKm({ lat: r.lat, lon: r.lon }, { lat: slot.lat, lon: slot.lon })) }))
      .filter((x) => x.km <= opts.maxDistanceKm)
      .sort((a, b) => a.km - b.km || a.slot.facilityId.localeCompare(b.slot.facilityId));
    if (r.preferredFacilityId) {
      const i = list.findIndex((x) => x.slot.facilityId === r.preferredFacilityId);
      if (i > 0) list.unshift(...list.splice(i, 1));
    }
    prefs.set(r.id, list);
  }

  const byId = new Map(reqs.map((r) => [r.id, r]));
  // Centre preference: nearer patient first, then tieKey.
  const better = (slot: AllocSlot, a: string, b: string) => {
    const da = prefs.get(a)!.find((x) => x.slot.slotId === slot.slotId)!.km;
    const db = prefs.get(b)!.find((x) => x.slot.slotId === slot.slotId)!.km;
    return da !== db ? da < db : byId.get(a)!.tieKey < byId.get(b)!.tieKey;
  };

  const held = new Map<string, string[]>(); // slotId -> requestIds
  const next = new Map<string, number>(); // requestId -> next proposal index
  const decisions: Decision[] = [];
  const free = reqs.map((r) => r.id);

  while (free.length) {
    const rid = free.shift()!;
    const list = prefs.get(rid)!;
    const idx = next.get(rid) ?? 0;
    if (idx >= list.length) continue; // exhausted — waitlisted below
    next.set(rid, idx + 1);
    const { slot, km } = list[idx];
    const holders = held.get(slot.slotId) ?? [];
    holders.push(rid);
    holders.sort((a, b) => (better(slot, a, b) ? -1 : 1));
    if (holders.length > slot.remaining) {
      const bumped = holders.pop()!;
      const bumpedKm = prefs.get(bumped)!.find((x) => x.slot.slotId === slot.slotId)!.km;
      decisions.push({
        requestId: bumped,
        facilityId: slot.facilityId,
        slotId: slot.slotId,
        distanceKm: bumpedKm,
        preferenceRank: (next.get(bumped) ?? 1),
        outcome: "rejected_capacity",
        reason: `Slot full: ${slot.remaining} seat(s) went to patients nearer than ${bumpedKm} km.`,
      });
      free.push(bumped);
    }
    held.set(slot.slotId, holders);
    void km;
  }

  const assignments: Assignment[] = [];
  const assigned = new Set<string>();
  for (const [slotId, holders] of held) {
    holders.forEach((rid, i) => {
      const list = prefs.get(rid)!;
      const pos = list.findIndex((x) => x.slot.slotId === slotId);
      const { slot, km } = list[pos];
      assignments.push({ requestId: rid, slotId, facilityId: slot.facilityId, distanceKm: km, preferenceRank: pos + 1, rankAtFacility: i + 1 });
      assigned.add(rid);
      decisions.push({
        requestId: rid,
        facilityId: slot.facilityId,
        slotId,
        distanceKm: km,
        preferenceRank: pos + 1,
        outcome: "allocated",
        reason:
          pos === 0
            ? `Allocated to ${r2s(km)} km centre — patient's ${reqs.find((r) => r.id === rid)?.preferredFacilityId === slot.facilityId ? "preferred" : "nearest eligible"} centre (rank ${i + 1} of ${holders.length} by distance).`
            : `Nearer centre(s) were full; allocated to next-nearest eligible centre with capacity (choice ${pos + 1}, ${r2s(km)} km).`,
      });
    });
  }

  const waitlisted: AllocationResult["waitlisted"] = [];
  for (const r of reqs) {
    if (assigned.has(r.id)) continue;
    const reason = prefs.get(r.id)!.length === 0 ? "no_eligible_centre" : "no_capacity";
    waitlisted.push({ requestId: r.id, reason });
    decisions.push({
      requestId: r.id,
      facilityId: null,
      slotId: null,
      distanceKm: null,
      preferenceRank: null,
      outcome: "waitlisted",
      reason:
        reason === "no_eligible_centre"
          ? `No eligible centre with capacity within ${opts.maxDistanceKm} km for this service and time.`
          : "All eligible centres within range were filled by nearer patients.",
    });
  }
  assignments.sort((a, b) => a.slotId.localeCompare(b.slotId) || a.rankAtFacility - b.rankAtFacility);
  return { assignments, waitlisted, decisions };
}

function r2s(n: number) {
  return n.toFixed(2);
}
