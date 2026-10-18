import "server-only";
import type { AppUser } from "../auth/permissions";
import type { Queryable } from "../db/types";

/** Append an audit entry inside the caller's transaction (RLS: actor = auth.uid()). */
export async function audit(
  q: Queryable,
  user: AppUser,
  action: string,
  entityType: string,
  entityId: string | null,
  facilityId: string | null,
  details: Record<string, unknown> = {},
) {
  await q.query(
    `insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, facility_id, details)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [user.id, user.role, action, entityType, entityId, facilityId, JSON.stringify(details)],
  );
}
