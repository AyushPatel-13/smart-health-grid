import type { Metadata } from "next";
import { PageHeader, Notice } from "@/components/ui/primitives";
import { ALLOCATION_RULES } from "@/lib/config/rules";
import { availableTimes } from "@/lib/allocation/recommend";
import { bookableDates, slotInstant, windowBounds } from "@/lib/allocation/service";
import { getCurrentUser } from "@/lib/auth/user";
import { LOCALITIES } from "@/lib/db/seed-patients";
import { withSystem } from "@/lib/db";
import { localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Register" };

export default async function RegisterPage() {
  const { t, locale } = await getI18n();
  const staff = await getCurrentUser();
  const now = new Date();
  const { cutoff } = windowBounds(now);
  const earliest = cutoff.getTime() + ALLOCATION_RULES.minLeadMinutes * 60_000;
  const dates = bookableDates();

  const { services, times } = await withSystem(async (q) => {
    const services = await q.query<{ id: string; code: string; name: string; name_hi: string | null; is_emergency: boolean; category: string }>(
      `select id, code, name, name_hi, is_emergency, category from public.services order by is_emergency, name`,
    );
    const times: Record<string, Record<string, string[]>> = {};
    for (const s of services) {
      times[s.id] = {};
      for (const d of dates) {
        const all = await availableTimes(q, s.id, d);
        times[s.id][d] = all.filter((tm) => slotInstant(d, tm).getTime() >= earliest);
      }
    }
    return { services, times };
  });

  return (
    <>
      <PageHeader title={t("patient.registerTitle")} subtitle={t("patient.registerSubtitle")} />
      {staff && (
        <Notice tone="info" className="mb-4">
          {t("patient.assisted")}
        </Notice>
      )}
      <RegisterForm
        services={services.map((s) => ({ id: s.id, name: localName(s, locale), emergency: s.is_emergency, category: s.category }))}
        dates={dates}
        times={times}
        localities={LOCALITIES.map((l) => ({ name: localName(l, locale), value: l.name, lat: l.lat, lon: l.lon }))}
        cutoffIso={cutoff.toISOString()}
      />
    </>
  );
}
