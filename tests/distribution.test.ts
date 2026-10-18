import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideDistribution, safeLendable } from "@/lib/analytics/distribution";
import type { StockPosition } from "@/lib/analytics/redistribution";
import { loadSnapshots } from "@/lib/data/snapshot";
import { computeDistribution } from "@/lib/distribution/service";
import { addDays, todayIST } from "@/lib/dates";
import { createTestDb, type TestDb } from "./helpers/db";

const today = todayIST();

// ---------------------------------------------------------------------------
// Pure decision engine
// ---------------------------------------------------------------------------
const pos = (o: Partial<StockPosition> & { facilityId: string }): StockPosition => ({
  facilityName: o.facilityId,
  medicineId: "M",
  medicineName: "Med",
  unit: "tablet",
  latitude: 25.4,
  longitude: 82.0,
  batches: [],
  usable: 0,
  dailyDemand: 10,
  safetyStock: 70,
  leadTimeDays: 10,
  risk: "ok",
  daysUntilStockout: null,
  deliveries: [],
  ...o,
});
const batch = (qty: number, days: number, n = "B1") => ({ id: n, batchNumber: n, quantity: qty, expiryDate: addDays(today, days) });

describe("emergency borrowing decision engine", () => {
  it("safe lendable excludes expired / short-shelf-life stock, commitments, safety stock and the donor's own lead-time demand", () => {
    const donor = pos({ facilityId: "D", usable: 1000, batches: [batch(200, 10, "SHORT"), batch(800, 300, "LONG")] });
    const s = safeLendable(donor, 100, today);
    // usable 1000 − committed 100 − safety 70 − demand 10×10 = 730, but only 800 long-dated − 100 committed = 700 transferable
    expect(s.transferable).toBe(800);
    expect(s.lendable).toBe(700);
  });

  it("recommends B (emergency borrow) when a lender fully bridges the gap to a scheduled delivery", () => {
    const rcp = pos({ facilityId: "R", usable: 20, risk: "critical", daysUntilStockout: 2, deliveries: [{ quantity: 500, expectedDate: addDays(today, 8) }] });
    const donor = pos({ facilityId: "D", usable: 3000, longitude: 82.02, batches: [batch(3000, 400)] });
    const [r] = decideDistribution([rcp, donor], new Map(), today);
    expect(r.decision).toBe("emergency_borrow");
    expect(r.chosen?.facilityId).toBe("D");
    expect(r.proposedQuantity).toBe(r.requiredQuantity);
    expect(r.urgency).toBe("high");
  });

  it("recommends C (borrow + linked replenishment) when only partial stock can be lent", () => {
    const rcp = pos({ facilityId: "R", usable: 0, risk: "stock_out", daysUntilStockout: 0 });
    const donor = pos({ facilityId: "D", usable: 230, longitude: 82.02, batches: [batch(230, 400)] });
    const [r] = decideDistribution([rcp, donor], new Map(), today);
    expect(r.decision).toBe("emergency_borrow_plus_replenishment");
    expect(r.proposedQuantity).toBeLessThan(r.requiredQuantity);
    expect(r.replenishmentQuantity).toBeGreaterThan(0);
    // Donor keeps safety (70) + lead-time demand (100): lendable 60.
    expect(r.proposedQuantity).toBe(60);
  });

  it("escalates (D) when no safe lender exists — never breaching donor safety stock", () => {
    const rcp = pos({ facilityId: "R", usable: 0, risk: "stock_out", daysUntilStockout: 0 });
    const donor = pos({ facilityId: "D", usable: 150, batches: [batch(150, 400)] }); // 150 < 70 + 100
    const [r] = decideDistribution([rcp, donor], new Map(), today);
    expect(r.decision).toBe("escalate");
    expect(r.chosen).toBeNull();
  });

  it("never lends expired stock", () => {
    const rcp = pos({ facilityId: "R", usable: 0, risk: "stock_out", daysUntilStockout: 0 });
    const donor = pos({ facilityId: "D", usable: 0, batches: [batch(5000, -3, "EXPIRED")] });
    const [r] = decideDistribution([rcp, donor], new Map(), today);
    expect(r.decision).toBe("escalate");
  });

  it("recommends A (normal replenishment) when only below safety stock", () => {
    const rcp = pos({ facilityId: "R", usable: 50, risk: "low" });
    const [r] = decideDistribution([rcp], new Map(), today);
    expect(r.decision).toBe("normal_replenishment");
    expect(r.urgency).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------
let t: TestDb;
let admin: string;
let staffAmarpur: string;
beforeAll(async () => {
  t = await createTestDb();
  admin = await t.user("admin");
  staffAmarpur = await t.user("staff_amarpur");
});
afterAll(async () => {
  await t?.close();
});

const usable = (facilityCode: string, medCode: string) =>
  t.sys(async (q) => {
    const [r] = await q.query<{ n: number }>(
      `select coalesce(sum(b.quantity_available), 0)::int as n from public.inventory_batches b
         join public.health_centres h on h.id = b.facility_id join public.medicines m on m.id = b.medicine_id
        where h.code = $1 and m.code = $2 and b.expiry_date >= current_date`,
      [facilityCode, medCode],
    );
    return r.n;
  });

describe("medicine distribution lifecycle (database)", () => {
  it("full loan lifecycle: approve → partial dispatch → partial receipt → ledger → restoration → closed", async () => {
    const [rec] = await t.sys((q) =>
      q.query<{ id: string; decision: string; donor_facility_id: string; proposed_quantity: number; replenishment_quantity: number; medicine_id: string; recipient_facility_id: string }>(
        `select r.* from public.transfer_recommendations r join public.health_centres h on h.id = r.recipient_facility_id
           join public.medicines m on m.id = r.medicine_id
          where r.status = 'open' and h.code = 'PHC-SDP-01' and m.code = 'MED-AMX500'`,
      ),
    );
    expect(rec).toBeTruthy();
    expect(["emergency_borrow", "emergency_borrow_plus_replenishment"]).toContain(rec.decision);
    const donorCode = (await t.sys((q) => q.query<{ code: string }>(`select code from public.health_centres where id = $1`, [rec.donor_facility_id])))[0].code;
    const donorBefore = await usable(donorCode, "MED-AMX500");
    const rcpBefore = await usable("PHC-SDP-01", "MED-AMX500");
    const qty = rec.proposed_quantity;

    // Staff cannot approve.
    await expect(t.as(staffAmarpur, (q) => q.query(`select public.approve_recommendation($1, $2, $3, $4, null)`, [rec.id, rec.donor_facility_id, qty, rec.replenishment_quantity]))).rejects.toThrow(/FORBIDDEN/);

    const [{ approve_recommendation: tid }] = await t.as(admin, (q) =>
      q.query<{ approve_recommendation: string }>(`select public.approve_recommendation($1, $2, $3, $4, 'Approved in test')`, [rec.id, rec.donor_facility_id, qty, rec.replenishment_quantity]),
    );
    // Approving twice is rejected (no duplicate transfers).
    await expect(t.as(admin, (q) => q.query(`select public.approve_recommendation($1, $2, $3, $4, null)`, [rec.id, rec.donor_facility_id, qty, 0]))).rejects.toThrow(/RECOMMENDATION_STALE/);
    expect(await usable(donorCode, "MED-AMX500")).toBe(donorBefore); // approval reserves, does not move stock

    // Staff of the RECIPIENT cannot dispatch from the donor.
    await expect(t.as(staffAmarpur, (q) => q.query(`select public.dispatch_transfer($1, $2, null)`, [tid, qty]))).rejects.toThrow(/FORBIDDEN/);

    // Partial dispatch needs a reason; concurrent identical dispatches move stock once.
    await expect(t.as(admin, (q) => q.query(`select public.dispatch_transfer($1, $2, null)`, [tid, qty - 10]))).rejects.toThrow(/REASON_REQUIRED/);
    await Promise.all([
      t.as(admin, (q) => q.query(`select public.dispatch_transfer($1, $2, 'Packed 10 short')`, [tid, qty - 10])),
      t.as(admin, (q) => q.query(`select public.dispatch_transfer($1, $2, 'Packed 10 short')`, [tid, qty - 10])),
    ]);
    expect(await usable(donorCode, "MED-AMX500")).toBe(donorBefore - (qty - 10));
    expect(await usable("PHC-SDP-01", "MED-AMX500")).toBe(rcpBefore); // destination unchanged until receipt

    // Partial receipt with discrepancy notes.
    const received = qty - 15;
    const [{ receive_transfer: st }] = await t.as(staffAmarpur, (q) =>
      q.query<{ receive_transfer: string }>(`select public.receive_transfer($1, $2, '5 capsules damaged in transit')`, [tid, received]),
    );
    expect(st).toBe("replenishment_pending");
    expect(await usable("PHC-SDP-01", "MED-AMX500")).toBe(rcpBefore + received);
    const [tr] = await t.sys((q) => q.query<{ discrepancy_quantity: number; status: string }>(`select discrepancy_quantity, status from public.transfer_requests where id = $1`, [tid]));
    expect(tr.discrepancy_quantity).toBe(5);

    // Ledger links lender, borrower, quantity and batches; lender restoration request created.
    const [ledger] = await t.sys((q) => q.query<{ id: string; quantity_borrowed: number; status: string; batch_details: unknown[] }>(
      `select id, quantity_borrowed, status, batch_details from public.borrowing_ledger where transfer_id = $1`, [tid]));
    expect(ledger.quantity_borrowed).toBe(received);
    expect(ledger.batch_details.length).toBeGreaterThan(0);
    const [rst] = await t.sys((q) => q.query<{ id: string; quantity_requested: number }>(
      `select id, quantity_requested from public.replenishment_requests where ledger_id = $1 and purpose = 'lender_restoration'`, [ledger.id]));
    expect(rst.quantity_requested).toBe(received);

    // The lender's stock does NOT rise just because the borrower received supplies.
    const donorAfterDispatch = await usable(donorCode, "MED-AMX500");
    const borrowerRepl = await t.sys((q) => q.query<{ id: string; quantity_requested: number }>(
      `select id, quantity_requested from public.replenishment_requests where transfer_id = $1 and purpose = 'borrower_replenishment'`, [tid]));
    for (const b of borrowerRepl) {
      await t.as(admin, (q) => q.query(`select public.receive_replenishment($1, $2, 'AMX-WH-B1', $3::date, null)`, [b.id, b.quantity_requested, addDays(today, 500)]));
    }
    expect(await usable(donorCode, "MED-AMX500")).toBe(donorAfterDispatch);

    // Failed restoration keeps the obligation open; re-issue and restore in two parts.
    await t.as(admin, (q) => q.query(`select public.fail_replenishment($1, 'Warehouse stock-out')`, [rst.id]));
    expect((await t.sys((q) => q.query<{ status: string }>(`select status from public.borrowing_ledger where id = $1`, [ledger.id])))[0].status).toBe("open");
    const [{ reissue_replenishment: rst2 }] = await t.as(admin, (q) => q.query<{ reissue_replenishment: string }>(`select public.reissue_replenishment($1, null)`, [rst.id]));
    const half = Math.floor(received / 2);
    await t.as(admin, (q) => q.query(`select public.receive_replenishment($1, $2, 'AMX-WH-R1', $3::date, null)`, [rst2, half, addDays(today, 500)]));
    expect(await usable(donorCode, "MED-AMX500")).toBe(donorAfterDispatch + half);
    expect((await t.sys((q) => q.query<{ status: string }>(`select status from public.borrowing_ledger where id = $1`, [ledger.id])))[0].status).toBe("partially_restored");
    await t.as(admin, (q) => q.query(`select public.receive_replenishment($1, $2, 'AMX-WH-R2', $3::date, null)`, [rst2, received - half, addDays(today, 500)]));
    const [done] = await t.sys((q) => q.query<{ status: string; quantity_restored: number }>(`select status, quantity_restored from public.borrowing_ledger where id = $1`, [ledger.id]));
    expect(done).toEqual({ status: "restored", quantity_restored: received });
    const [closed] = await t.sys((q) => q.query<{ status: string }>(`select status from public.transfer_requests where id = $1`, [tid]));
    expect(closed.status).toBe("closed");

    // Full lifecycle is recorded.
    const events = await t.sys((q) => q.query<{ event: string }>(`select event from public.transfer_events where transfer_id = $1 order by created_at, id`, [tid]));
    expect(events.map((e) => e.event)).toEqual(
      expect.arrayContaining(["shortage_detected", "recommendation_created", "approved", "dispatched", "received", "discrepancy", "replenishment_pending", "stock_restored", "closed"]),
    );
  });

  it("rejects dispatch that would push the donor below safety stock", async () => {
    const [ids] = await t.sys((q) => q.query<{ med: string; donor: string; rcp: string; usable: number }>(
      `select m.id as med, d.id as donor, r.id as rcp,
              (select coalesce(sum(quantity_available), 0)::int from public.inventory_batches b where b.facility_id = d.id and b.medicine_id = m.id
                and b.expiry_date >= current_date + 30) as usable
         from public.medicines m, public.health_centres d, public.health_centres r
        where m.code = 'MED-MET500' and d.code = 'PHC-SDP-03' and r.code = 'PHC-SDP-02'`));
    const [{ id }] = await t.as(admin, (q) => q.query<{ id: string }>(
      `insert into public.transfer_requests (request_code, medicine_id, from_facility_id, to_facility_id, quantity, status, justification, requested_by)
       values ('TR-TEST-SAFE', $1, $2, $3, $4, 'pending', 'Test over-lend', $5) returning id`, [ids.med, ids.donor, ids.rcp, ids.usable, admin]));
    await expect(t.as(admin, (q) => q.query(`select public.review_transfer($1, true, null, null, null)`, [id]))).rejects.toThrow(/DONOR_BELOW_SAFETY_STOCK/);
  });

  it("a failed delivery returns stock to the donor's batches", async () => {
    const [ids] = await t.sys((q) => q.query<{ med: string; donor: string; rcp: string }>(
      `select m.id as med, d.id as donor, r.id as rcp from public.medicines m, public.health_centres d, public.health_centres r
        where m.code = 'MED-AML5' and d.code = 'PHC-SDP-06' and r.code = 'PHC-SDP-08'`));
    const before = await usable("PHC-SDP-06", "MED-AML5");
    const [{ id }] = await t.as(admin, (q) => q.query<{ id: string }>(
      `insert into public.transfer_requests (request_code, medicine_id, from_facility_id, to_facility_id, quantity, status, justification, requested_by)
       values ('TR-TEST-FAIL', $1, $2, $3, 20, 'pending', 'Test failed delivery', $4) returning id`, [ids.med, ids.donor, ids.rcp, admin]));
    await t.as(admin, (q) => q.query(`select public.review_transfer($1, true, null, null, null)`, [id]));
    await t.as(admin, (q) => q.query(`select public.dispatch_transfer($1, 20, null)`, [id]));
    expect(await usable("PHC-SDP-06", "MED-AML5")).toBe(before - 20);
    await t.as(admin, (q) => q.query(`select public.fail_transfer($1, 'Vehicle breakdown, returned')`, [id]));
    expect(await usable("PHC-SDP-06", "MED-AML5")).toBe(before);
    // A failed transfer cannot then be received.
    await expect(t.as(admin, (q) => q.query(`select public.receive_transfer($1, 20, null)`, [id]))).rejects.toThrow(/TRANSFER_NOT_DISPATCHED/);
  });

  it("rejected recommendations are recorded with a reason and stop appearing as open", async () => {
    const [rec] = await t.sys((q) => q.query<{ id: string }>(`select id from public.transfer_recommendations where status = 'open' limit 1`));
    await expect(t.as(admin, (q) => q.query(`select public.reject_recommendation($1, 'no')`, [rec.id]))).rejects.toThrow(/REASON_REQUIRED/);
    await t.as(admin, (q) => q.query(`select public.reject_recommendation($1, 'Supply already arranged by phone')`, [rec.id]));
    const [r] = await t.sys((q) => q.query<{ status: string; decision_notes: string }>(`select status, decision_notes from public.transfer_recommendations where id = $1`, [rec.id]));
    expect(r.status).toBe("rejected");
  });

  it("the seeded overdue, partially restored obligation is visible to the lender and flagged", async () => {
    const [l] = await t.sys((q) => q.query<{ status: string; quantity_borrowed: number; quantity_restored: number; due_date: string }>(
      `select l.status, l.quantity_borrowed, l.quantity_restored, l.due_date from public.borrowing_ledger l join public.transfer_requests t on t.id = l.transfer_id where t.request_code = 'LN-DEMO-0001'`));
    expect(l).toMatchObject({ status: "partially_restored", quantity_borrowed: 300, quantity_restored: 120 });
    expect(l.due_date < today).toBe(true);
    const alerts = await t.sys((q) => q.query(`select 1 from public.alerts where category = 'restoration_overdue' and status <> 'resolved'`));
    expect(alerts.length).toBeGreaterThan(0);
  });

  it("recommendations recomputed from live data never propose more than the donor can safely lend", async () => {
    const recs = await t.sys(async (q) => computeDistribution(q, await loadSnapshots(q, { today }), today));
    expect(recs.length).toBeGreaterThan(0);
    for (const r of recs) {
      if (!r.chosen) continue;
      expect(r.proposedQuantity).toBeLessThanOrEqual(r.chosen.lendable);
      expect(r.chosen.usable - r.chosen.committed - r.proposedQuantity).toBeGreaterThanOrEqual(r.chosen.safetyStock);
    }
  });
});
