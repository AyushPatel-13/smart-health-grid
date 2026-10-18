// One-off: facility Loans tab, navigation entries and icons.
import fs from "node:fs";
const edit = (file, pairs) => {
  let s = fs.readFileSync(file, "utf8");
  for (const [a, b] of pairs) {
    if (!s.includes(a)) throw new Error(`${file}: missing ${a.slice(0, 60)}`);
    s = s.replace(a, b);
  }
  fs.writeFileSync(file, s);
  console.log("patched", file);
};

edit("src/app/(app)/facilities/[id]/page.tsx", [
  ['import { AlertsTab, BedsTab, DiagnosticsTab, InventoryTab, OverviewTab, PatientsTab, StaffTab } from "./tabs";',
    'import { AlertsTab, BedsTab, DiagnosticsTab, InventoryTab, OverviewTab, PatientsTab, StaffTab } from "./tabs";\nimport { LoansTab } from "./loans-tab";'],
  ['const TABS = ["overview", "inventory", "patients", "beds", "staff", "diagnostics", "alerts"] as const;',
    'const TABS = ["overview", "inventory", "loans", "patients", "beds", "staff", "diagnostics", "alerts"] as const;'],
  ['    inventory: t("facility.tabInventory"),\n', '    inventory: t("facility.tabInventory"),\n    loans: t("distribution.facilityTitle"),\n'],
  ['      {tab === "inventory" && <InventoryTab {...ctx} />}', '      {tab === "inventory" && <InventoryTab {...ctx} />}\n      {tab === "loans" && <LoansTab {...ctx} />}'],
]);

edit("src/components/layout/nav-config.ts", [
  ['  | "register";', '  | "register"\n  | "distribution"\n  | "workforce"\n  | "myAttendance";'],
  ['        { href: "/inventory", label: "nav.inventory", icon: "inventory" },',
    '        { href: "/inventory", label: "nav.inventory", icon: "inventory" },\n        { href: "/distribution", label: "nav.distribution", icon: "distribution" },'],
  ['        { href: "/attendance", label: "nav.attendance", icon: "attendance" },',
    '        { href: "/attendance", label: "nav.attendance", icon: "attendance" },\n        { href: "/workforce", label: "nav.workforce", icon: "workforce", roles: ["district_admin", "read_only"] },\n        { href: "/my-attendance", label: "nav.myAttendance", icon: "myAttendance", roles: ["facility_staff"] },'],
]);

edit("src/components/layout/app-shell.tsx", [
  ['  UserPlus,\n} from "lucide-react";', '  UserPlus,\n  Truck,\n  Stethoscope,\n  MapPinCheck,\n} from "lucide-react";'],
  ['  register: UserPlus,\n};', '  register: UserPlus,\n  distribution: Truck,\n  workforce: Stethoscope,\n  myAttendance: MapPinCheck,\n};'],
]);
