import type { Queryable } from "../db/types";
import { loadSnapshots } from "../data/snapshot";
import { obligationAlerts, refreshRecommendations } from "../distribution/service";
import { workforceAlerts } from "../workforce/service";
import { overloadAlerts } from "../operations/live";
import { syncAlerts } from "./alerts";

/**
 * One deterministic evaluation pass over all facilities (trusted context):
 * rule alerts (stock, beds, staffing, diagnostics, footfall, freshness,
 * obligations, workforce) and persisted distribution recommendations.
 */
export async function evaluateAll(q: Queryable, today: string) {
  const snaps = await loadSnapshots(q, { today });
  const ids = snaps.map((s) => s.facility.id);
  const extra = [...(await obligationAlerts(q, ids, today)), ...(await workforceAlerts(q, snaps, today)), ...(await overloadAlerts(q, snaps, today))];
  const alerts = await syncAlerts(q, snaps, today, extra);
  const recommendations = await refreshRecommendations(q, snaps, today);
  return { ...alerts, recommendations };
}
