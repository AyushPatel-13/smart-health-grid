import type { Role } from "@/lib/auth/permissions";
import type { TKey } from "@/lib/i18n";

export type IconName =
  | "dashboard"
  | "facilities"
  | "inventory"
  | "footfall"
  | "beds"
  | "attendance"
  | "diagnostics"
  | "alerts"
  | "forecasts"
  | "risk"
  | "redistribution"
  | "transfers"
  | "reports"
  | "audit"
  | "admin"
  | "queue"
  | "allocation"
  | "register"
  | "distribution"
  | "workforce"
  | "myAttendance";

export interface NavItem {
  href: string;
  label: TKey;
  icon: IconName;
  roles?: Role[];
}

export interface NavSection {
  label: TKey;
  items: NavItem[];
}

export function navFor(role: Role, facilityId: string | null): NavSection[] {
  const sections: NavSection[] = [
    {
      label: "nav.sectionOverview",
      items: [
        { href: "/dashboard", label: "nav.dashboard", icon: "dashboard" },
        role === "facility_staff" && facilityId
          ? { href: `/facilities/${facilityId}`, label: "nav.myFacility", icon: "facilities" }
          : { href: "/facilities", label: "nav.facilities", icon: "facilities" },
        { href: "/alerts", label: "nav.alerts", icon: "alerts" },
      ],
    },
    {
      label: "nav.sectionPatients",
      items: [
        { href: "/queue", label: "nav.queue", icon: "queue", roles: ["district_admin", "facility_staff"] },
        { href: "/allocation", label: "nav.allocation", icon: "allocation", roles: ["district_admin"] },
        { href: "/register", label: "nav.registerPatient", icon: "register", roles: ["district_admin", "facility_staff"] },
      ],
    },
    {
      label: "nav.sectionOperations",
      items: [
        { href: "/inventory", label: "nav.inventory", icon: "inventory" },
        { href: "/distribution", label: "nav.distribution", icon: "distribution" },
        { href: "/footfall", label: "nav.footfall", icon: "footfall" },
        { href: "/beds", label: "nav.beds", icon: "beds" },
        { href: "/attendance", label: "nav.attendance", icon: "attendance" },
        { href: "/workforce", label: "nav.workforce", icon: "workforce", roles: ["district_admin", "read_only"] },
        { href: "/my-attendance", label: "nav.myAttendance", icon: "myAttendance", roles: ["facility_staff"] },
        { href: "/diagnostics", label: "nav.diagnostics", icon: "diagnostics" },
      ],
    },
    {
      label: "nav.sectionIntelligence",
      items: [
        { href: "/forecasts", label: "nav.forecasts", icon: "forecasts" },
        { href: "/risk", label: "nav.risk", icon: "risk", roles: ["district_admin", "read_only"] },
        { href: "/redistribution", label: "nav.redistribution", icon: "redistribution", roles: ["district_admin", "read_only"] },
        { href: "/transfers", label: "nav.transfers", icon: "transfers" },
      ],
    },
    {
      label: "nav.sectionGovernance",
      items: [
        { href: "/reports", label: "nav.reports", icon: "reports" },
        { href: "/audit", label: "nav.audit", icon: "audit", roles: ["district_admin", "read_only"] },
        { href: "/admin", label: "nav.admin", icon: "admin", roles: ["district_admin"] },
      ],
    },
  ];
  return sections.map((s) => ({ ...s, items: s.items.filter((i) => !i.roles || i.roles.includes(role)) }));
}
