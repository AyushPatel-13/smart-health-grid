import { AppShell } from "@/components/layout/app-shell";
import { navFor } from "@/components/layout/nav-config";
import { requireUser } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { isDemoMode } from "@/lib/env";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requireUser();
  const [{ n }] = await withUser(user.id, (q) =>
    q.query<{ n: number }>(`select count(*)::int as n from public.alerts where status <> 'resolved' and severity = 'critical'`),
  );
  return (
    <AppShell user={user} sections={navFor(user.role, user.facilityId)} alertCount={n} demoMode={isDemoMode()}>
      {children}
    </AppShell>
  );
}
