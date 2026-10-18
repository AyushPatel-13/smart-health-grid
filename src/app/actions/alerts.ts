"use server";

import { can } from "@/lib/auth/permissions";
import { withUser } from "@/lib/db";
import { audit } from "@/lib/actions/audit";
import { fail, ok } from "@/lib/actions/result";
import { refreshAlerts, runAction } from "@/lib/actions/run";
import { alertActionSchema, manualAlertSchema } from "@/lib/validation/schemas";
import { z } from "zod";

const TRANSITIONS: Record<string, string[]> = {
  acknowledge: ["open"],
  resolve: ["open", "acknowledged"],
  reopen: ["resolved"],
  assign: ["open", "acknowledged"],
};

export async function alertTransitionAction(input: unknown) {
  return runAction(alertActionSchema, input, async (user, d) => {
    if (!can(user, "alerts:manage")) return fail("FORBIDDEN");
    await withUser(user.id, async (q) => {
      const rows = await q.query<{ id: string; status: string; facility_id: string }>(
        `select id, status, facility_id from public.alerts where id = $1 for update`,
        [d.alertId],
      );
      const a = rows[0];
      if (!a) throw new Error("FORBIDDEN");
      if (!TRANSITIONS[d.action].includes(a.status)) throw new Error("INVALID_TRANSITION");

      if (d.action === "assign") {
        const assignee = await q.query<{ id: string; full_name: string }>(
          `select id, full_name from public.profiles where id = $1 and is_active and role = 'district_admin'`,
          [d.assigneeId],
        );
        if (!assignee[0]) throw new Error("FORBIDDEN");
        await q.query(`update public.alerts set assigned_to = $2 where id = $1`, [a.id, assignee[0].id]);
        await q.query(
          `insert into public.alert_events (alert_id, event_type, actor_id, notes, details) values ($1, 'assigned', $2, $3, $4::jsonb)`,
          [a.id, user.id, d.notes ?? `Assigned to ${assignee[0].full_name}`, JSON.stringify({ assignee: assignee[0].id })],
        );
      } else if (d.action === "acknowledge") {
        await q.query(
          `update public.alerts set status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2,
                  assigned_to = coalesce(assigned_to, $2) where id = $1`,
          [a.id, user.id],
        );
        await q.query(`insert into public.alert_events (alert_id, event_type, actor_id, notes) values ($1, 'acknowledged', $2, $3)`, [a.id, user.id, d.notes]);
      } else if (d.action === "resolve") {
        await q.query(
          `update public.alerts set status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_notes = $3 where id = $1`,
          [a.id, user.id, d.notes],
        );
        await q.query(`insert into public.alert_events (alert_id, event_type, actor_id, notes) values ($1, 'resolved', $2, $3)`, [a.id, user.id, d.notes]);
      } else {
        await q.query(
          `update public.alerts set status = 'open', resolved_at = null, resolved_by = null, acknowledged_at = null where id = $1`,
          [a.id],
        );
        await q.query(`insert into public.alert_events (alert_id, event_type, actor_id, notes) values ($1, 'reopened', $2, $3)`, [a.id, user.id, d.notes]);
      }
      await audit(q, user, `alert.${d.action}`, "alert", a.id, a.facility_id, { notes: d.notes, assignee: d.assigneeId });
    });
    return ok("alerts.success");
  });
}

export async function createManualAlertAction(input: unknown) {
  return runAction(manualAlertSchema, input, async (user, d) => {
    if (!can(user, "alerts:manage")) return fail("FORBIDDEN");
    await withUser(user.id, async (q) => {
      const rows = await q.query<{ id: string }>(
        `insert into public.alerts (facility_id, category, severity, title, explanation, recommended_action, source, created_by, assigned_to)
         values ($1, 'manual', $2, $3, $4, $5, 'manual', $6, $6) returning id`,
        [d.facilityId, d.severity, d.title, d.explanation, d.recommendedAction, user.id],
      );
      await q.query(`insert into public.alert_events (alert_id, event_type, actor_id, notes) values ($1, 'created', $2, 'Raised manually')`, [rows[0].id, user.id]);
      await audit(q, user, "alert.created", "alert", rows[0].id, d.facilityId, { title: d.title, severity: d.severity });
    });
    return ok("alerts.created_ok");
  });
}

export async function runAlertEngineAction() {
  return runAction(z.object({}), {}, async (user) => {
    if (!can(user, "alerts:manage")) return fail("FORBIDDEN");
    const ids = await withUser(user.id, (q) => q.query<{ id: string }>(`select id from public.health_centres`));
    const r = await refreshAlerts(ids.map((x) => x.id));
    await withUser(user.id, (q) => audit(q, user, "alerts.engine_run", "alerts", null, null, r));
    return ok("alerts.engineResult", { created: r.created, updated: r.updated, resolved: r.resolved });
  });
}
