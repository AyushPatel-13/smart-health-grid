"use server";

import { canWriteFacility } from "@/lib/auth/permissions";
import { withUser } from "@/lib/db";
import { todayIST } from "@/lib/dates";
import { fail, ok } from "@/lib/actions/result";
import { refreshAlerts, runAction } from "@/lib/actions/run";
import { addBatchSchema, adjustmentSchema, issueSchema, receiptSchema, writeOffSchema } from "@/lib/validation/schemas";

// All stock mutations call audited, transactional SQL functions; quantities
// are never overwritten directly. RLS + function-level checks enforce scope.

export async function addBatchAction(input: unknown) {
  return runAction(addBatchSchema, input, async (user, d) => {
    if (!canWriteFacility(user, d.facilityId)) return fail("FORBIDDEN");
    if (d.expiryDate <= todayIST()) return fail("VALIDATION", { expiryDate: "validation.pastExpiry" });
    await withUser(user.id, (q) =>
      q.query(`select public.add_inventory_batch($1, $2, $3, $4, $5::date, $6, $7, $8)`, [
        d.facilityId, d.medicineId, d.batchNumber, d.quantity, d.expiryDate, d.supplier, d.source, d.idempotencyKey,
      ]),
    );
    await refreshAlerts([d.facilityId]);
    return ok("inventory.successBatch");
  });
}

async function batchFacility(userId: string, batchId: string): Promise<string | null> {
  const rows = await withUser(userId, (q) =>
    q.query<{ facility_id: string }>(`select facility_id from public.inventory_batches where id = $1`, [batchId]),
  );
  return rows[0]?.facility_id ?? null;
}

export async function receiptAction(input: unknown) {
  return runAction(receiptSchema, input, async (user, d) => {
    const facilityId = await batchFacility(user.id, d.batchId);
    if (!facilityId) return fail("BATCH_NOT_FOUND");
    if (!canWriteFacility(user, facilityId)) return fail("FORBIDDEN");
    await withUser(user.id, (q) =>
      q.query(`select public.record_stock_movement($1, 'receipt', $2, $3, $4)`, [d.batchId, d.quantity, d.reason, d.idempotencyKey]),
    );
    await refreshAlerts([facilityId]);
    return ok("inventory.successMovement");
  });
}

export async function issueAction(input: unknown) {
  return runAction(issueSchema, input, async (user, d) => {
    if (!canWriteFacility(user, d.facilityId)) return fail("FORBIDDEN");
    await withUser(user.id, (q) =>
      q.query(`select public.issue_stock_fefo($1, $2, $3, $4, $5)`, [d.facilityId, d.medicineId, d.quantity, d.reason, d.idempotencyKey]),
    );
    await refreshAlerts([d.facilityId]);
    return ok("inventory.successIssue");
  });
}

export async function adjustmentAction(input: unknown) {
  return runAction(adjustmentSchema, input, async (user, d) => {
    const facilityId = await batchFacility(user.id, d.batchId);
    if (!facilityId) return fail("BATCH_NOT_FOUND");
    if (!canWriteFacility(user, facilityId)) return fail("FORBIDDEN");
    await withUser(user.id, (q) =>
      q.query(`select public.record_stock_movement($1, 'adjustment', $2, $3, $4)`, [d.batchId, d.quantity, d.reason, d.idempotencyKey]),
    );
    await refreshAlerts([facilityId]);
    return ok("inventory.successMovement");
  });
}

export async function writeOffAction(input: unknown) {
  return runAction(writeOffSchema, input, async (user, d) => {
    const facilityId = await batchFacility(user.id, d.batchId);
    if (!facilityId) return fail("BATCH_NOT_FOUND");
    if (!canWriteFacility(user, facilityId)) return fail("FORBIDDEN");
    await withUser(user.id, (q) =>
      q.query(`select public.record_stock_movement($1, 'expiry_writeoff', $2, $3, $4)`, [
        d.batchId, d.quantity, d.reason ?? "Expired stock written off", d.idempotencyKey,
      ]),
    );
    await refreshAlerts([facilityId]);
    return ok("inventory.successMovement");
  });
}
