// Role capabilities. These checks run on the server before every mutation;
// Postgres RLS policies enforce the same rules a second time. UI code may use
// them to hide controls, but hiding is never the only protection.

export type Role = "district_admin" | "facility_staff" | "read_only";

export interface AppUser {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  districtId: string | null;
  facilityId: string | null;
  facilityName: string | null;
  facilityNameHi: string | null;
  facilityCode: string | null;
  districtName: string | null;
  districtNameHi: string | null;
}

export type Permission =
  | "operations:write"
  | "alerts:manage"
  | "transfers:request"
  | "transfers:review"
  | "attendance:verify"
  | "admin:manage"
  | "audit:view"
  | "forecast:snapshot"
  | "demo:reset";

const MATRIX: Record<Role, Permission[]> = {
  district_admin: [
    "operations:write",
    "alerts:manage",
    "transfers:request",
    "transfers:review",
    "attendance:verify",
    "admin:manage",
    "audit:view",
    "forecast:snapshot",
    "demo:reset",
  ],
  facility_staff: ["operations:write", "transfers:request"],
  read_only: ["audit:view"],
};

export function can(user: Pick<AppUser, "role"> | null, permission: Permission): boolean {
  return !!user && MATRIX[user.role].includes(permission);
}

/** App-level facility write check (RLS re-checks district scope for admins). */
export function canWriteFacility(user: AppUser | null, facilityId: string): boolean {
  if (!user) return false;
  if (user.role === "district_admin") return true;
  if (user.role === "facility_staff") return user.facilityId === facilityId;
  return false;
}
