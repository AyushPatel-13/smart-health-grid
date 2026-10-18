import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { withSystem } from "../db";
import { getSessionUserId } from "./session";
import type { AppUser, Role } from "./permissions";

export type { AppUser, Role } from "./permissions";

/**
 * Resolve the signed-in user's profile. The role and facility scope come from
 * the database — never from the client — and the same profile row drives the
 * Row Level Security policies.
 */
export const getCurrentUser = cache(async (): Promise<AppUser | null> => {
  const uid = await getSessionUserId();
  if (!uid) return null;
  const rows = await withSystem((q) =>
    q.query<AppUser>(
      `select p.id, p.email, p.full_name as "fullName", p.role, p.district_id as "districtId",
              p.facility_id as "facilityId", h.name as "facilityName", h.name_hi as "facilityNameHi",
              h.code as "facilityCode", coalesce(d.name, hd.name) as "districtName",
              coalesce(d.name_hi, hd.name_hi) as "districtNameHi"
         from public.profiles p
         left join public.health_centres h on h.id = p.facility_id
         left join public.districts d on d.id = p.district_id
         left join public.districts hd on hd.id = h.district_id
        where p.id = $1 and p.is_active`,
      [uid],
    ),
  );
  return rows[0] ?? null;
});

export async function requireUser(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireRole(...roles: Role[]): Promise<AppUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect("/dashboard?denied=1");
  return user;
}
