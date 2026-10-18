import { describe, expect, it } from "vitest";
import { allocate, tieKey, type AllocRequest, type AllocSlot } from "@/lib/allocation/engine";
import { haversineKm } from "@/lib/analytics/redistribution";

// Geometry helper: a point `km` kilometres due east of (lat0, lon0).
const LAT0 = 25.4;
const LON0 = 82.0;
const east = (km: number) => LON0 + km / (111.32 * Math.cos((LAT0 * Math.PI) / 180));
const north = (km: number) => LAT0 + km / 110.574;

const req = (id: string, lat: number, lon: number, preferred?: string): AllocRequest => ({
  id,
  lat,
  lon,
  preferredFacilityId: preferred ?? null,
  tieKey: tieKey("w1", id),
});
const slot = (facilityId: string, lat: number, lon: number, remaining: number): AllocSlot => ({
  slotId: `slot-${facilityId}`,
  facilityId,
  lat,
  lon,
  remaining,
});
const opts = { maxDistanceKm: 30 };
const centreOf = (r: ReturnType<typeof allocate>, id: string) => r.assignments.find((a) => a.requestId === id)?.facilityId ?? null;

describe("nearest-first batch allocation", () => {
  it("spec example: PHC A's 2 slots go to the 2 nearest; others independently go to their own nearest alternative", () => {
    // PHC A at origin. Patients due east at 1.2, 2.0, 4.5, 6.0 km.
    // P3's nearest alternative is B (north of P3); P4's is C (north of P4).
    const A = slot("A", LAT0, LON0, 2);
    const B = slot("B", north(3), east(4.5), 5);
    const C = slot("C", north(3), east(6.0), 5);
    const r = allocate(
      [req("P1", LAT0, east(1.2)), req("P2", LAT0, east(2.0)), req("P3", LAT0, east(4.5)), req("P4", LAT0, east(6.0))],
      [A, B, C],
      opts,
    );
    expect(centreOf(r, "P1")).toBe("A");
    expect(centreOf(r, "P2")).toBe("A");
    expect(centreOf(r, "P3")).toBe("B");
    expect(centreOf(r, "P4")).toBe("C");
    expect(r.waitlisted).toHaveLength(0);
  });

  it("more patients than slots: never overbooks and the nearest win", () => {
    const A = slot("A", LAT0, LON0, 3);
    const reqs = [1, 2, 3, 4, 5, 6].map((k) => req(`P${k}`, LAT0, east(k)));
    const r = allocate(reqs, [A], opts);
    expect(r.assignments).toHaveLength(3);
    expect(r.assignments.map((a) => a.requestId).sort()).toEqual(["P1", "P2", "P3"]);
    expect(r.waitlisted.map((w) => w.requestId).sort()).toEqual(["P4", "P5", "P6"]);
    expect(r.waitlisted.every((w) => w.reason === "no_capacity")).toBe(true);
  });

  it("registration order does not matter", () => {
    const slots = [slot("A", LAT0, LON0, 2), slot("B", LAT0, east(10), 2)];
    const base = [1, 2, 3, 4, 5, 6, 7].map((k) => req(`P${k}`, north(k * 0.3), east(k * 1.4)));
    const r1 = allocate(base, slots, opts);
    const r2 = allocate([...base].reverse(), slots, opts);
    const r3 = allocate([base[3], base[0], base[6], base[2], base[5], base[1], base[4]], slots, opts);
    const key = (r: ReturnType<typeof allocate>) => r.assignments.map((a) => `${a.requestId}:${a.facilityId}`).sort().join(",");
    expect(key(r2)).toBe(key(r1));
    expect(key(r3)).toBe(key(r1));
  });

  it("multiple competing centres: result is stable (no patient prefers a centre that took someone farther)", () => {
    const slots = [slot("A", LAT0, LON0, 2), slot("B", north(4), east(1), 2), slot("C", north(-3), east(5), 1)];
    const reqs = Array.from({ length: 9 }, (_, i) => req(`P${i}`, north(Math.sin(i) * 3), east(Math.cos(i) * 4 + 2)));
    const r = allocate(reqs, slots, opts);
    const dist = (rid: string, fid: string) => {
      const q = reqs.find((x) => x.id === rid)!;
      const s = slots.find((x) => x.facilityId === fid)!;
      return haversineKm({ lat: q.lat, lon: q.lon }, { lat: s.lat, lon: s.lon });
    };
    for (const s of slots) {
      const holders = r.assignments.filter((a) => a.facilityId === s.facilityId);
      expect(holders.length).toBeLessThanOrEqual(s.remaining);
      const farthestHolder = Math.max(...holders.map((h) => dist(h.requestId, s.facilityId)), -1);
      for (const q of reqs) {
        const mine = centreOf(r, q.id);
        const myDist = mine ? dist(q.id, mine) : Infinity;
        const theirs = dist(q.id, s.facilityId);
        // Blocking pair: q prefers s, and s has spare capacity or holds someone farther than q.
        const blocking = theirs < myDist - 1e-9 && (holders.length < s.remaining || theirs < farthestHolder - 1e-9);
        expect(blocking).toBe(false);
      }
    }
  });

  it("alternative-centre allocation is per patient (not all overflow to the same centre)", () => {
    const A = slot("A", LAT0, LON0, 1);
    const West = slot("W", LAT0, east(-3), 1);
    const East = slot("E", LAT0, east(5), 1);
    const r = allocate([req("near", LAT0, east(0.5)), req("westish", LAT0, east(-1)), req("eastish", LAT0, east(2.5))], [A, West, East], opts);
    expect(centreOf(r, "near")).toBe("A");
    expect(centreOf(r, "westish")).toBe("W");
    expect(centreOf(r, "eastish")).toBe("E");
    expect(r.assignments.find((a) => a.requestId === "eastish")!.preferenceRank).toBe(2);
  });

  it("no available slots: everyone is waitlisted with a reason, nothing allocated", () => {
    const r = allocate([req("P1", LAT0, LON0), req("P2", LAT0, east(1))], [slot("A", LAT0, LON0, 0)], opts);
    expect(r.assignments).toHaveLength(0);
    expect(r.waitlisted).toHaveLength(2);
    expect(r.decisions.filter((d) => d.outcome === "waitlisted")).toHaveLength(2);
  });

  it("centres beyond the maximum distance are not eligible", () => {
    const r = allocate([req("P1", LAT0, LON0)], [slot("far", LAT0, east(45), 5)], opts);
    expect(r.waitlisted[0]).toEqual({ requestId: "P1", reason: "no_eligible_centre" });
  });

  it("equal-distance ties are broken by the documented seeded hash, not by input order", () => {
    // P1 and P2 are both exactly 1 km from A (north and south).
    const A = slot("A", LAT0, LON0, 1);
    const p1 = req("P1", north(1), LON0);
    const p2 = req("P2", north(-1), LON0);
    const r1 = allocate([p1, p2], [A], opts);
    const r2 = allocate([p2, p1], [A], opts);
    const winner = p1.tieKey < p2.tieKey ? "P1" : "P2";
    expect(r1.assignments[0].requestId).toBe(winner);
    expect(r2.assignments[0].requestId).toBe(winner);
  });

  it("facilities without the service are excluded upstream: only supplied slots are used", () => {
    // The service layer only passes slots at eligible centres; an empty list waitlists.
    const r = allocate([req("P1", LAT0, LON0)], [], opts);
    expect(r.waitlisted[0].reason).toBe("no_eligible_centre");
  });

  it("a preferred eligible centre is tried first, but still ranked by distance there", () => {
    const A = slot("A", LAT0, LON0, 1);
    const B = slot("B", LAT0, east(4), 1);
    const r = allocate([req("P1", LAT0, east(0.5), "B"), req("P2", LAT0, east(3.5))], [A, B], opts);
    // P2 is nearer to B than P1, so B goes to P2; P1 falls back to A.
    expect(centreOf(r, "P2")).toBe("B");
    expect(centreOf(r, "P1")).toBe("A");
  });

  it("is deterministic across repeated runs (idempotent decision)", () => {
    const slots = [slot("A", LAT0, LON0, 2), slot("B", north(2), east(2), 1)];
    const reqs = [1, 2, 3, 4].map((k) => req(`P${k}`, north(k * 0.4), east(k)));
    expect(allocate(reqs, slots, opts)).toEqual(allocate(reqs, slots, opts));
  });
});
