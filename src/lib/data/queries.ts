import "server-only";
import { cache } from "react";
import { requireUser } from "../auth/user";
import { withUser } from "../db";
import { todayIST } from "../dates";
import { loadSnapshots, toStockPositions } from "./snapshot";
import { recommendTransfers } from "../analytics/redistribution";

// Request-scoped loaders. Every query runs under the signed-in user's RLS
// context, so a facility staff member only ever receives their own centre.

export const getSnapshots = cache(async () => {
  const user = await requireUser();
  const today = todayIST();
  const snaps = await withUser(user.id, (q) => loadSnapshots(q, { today }));
  return { user, today, snaps };
});

export const getRecommendations = cache(async () => {
  const { snaps, today, user } = await getSnapshots();
  const recs = recommendTransfers(toStockPositions(snaps), today);
  // Mark recommendations that already have an in-flight request.
  const active = await withUser(user.id, (q) =>
    q.query<{ medicine_id: string; from_facility_id: string | null; to_facility_id: string; request_code: string }>(
      `select medicine_id, from_facility_id, to_facility_id, request_code from public.transfer_requests
        where status in ('pending', 'approved')`,
    ),
  );
  return recs.map((r) => {
    const existing = active.find(
      (a) => a.medicine_id === r.medicineId && a.to_facility_id === r.recipient.facilityId &&
        (a.from_facility_id === r.donor.facilityId || a.from_facility_id === null),
    );
    return { ...r, existingRequest: existing?.request_code ?? null };
  });
});

export const getDistricts = cache(async () => {
  const user = await requireUser();
  return withUser(user.id, (q) =>
    q.query<{ id: string; code: string; name: string; name_hi: string | null }>(
      `select id, code, name, name_hi from public.districts order by name`,
    ),
  );
});

export interface FacilityDirectoryEntry {
  id: string;
  code: string;
  name: string;
  name_hi: string | null;
  facility_type: string;
}

/** Names of centres in the user's district (no operational data). */
export const getFacilityDirectory = cache(async () => {
  const user = await requireUser();
  return withUser(user.id, (q) =>
    q.query<FacilityDirectoryEntry>(`select id, code, name, name_hi, facility_type from public.facility_directory() order by code`),
  );
});
