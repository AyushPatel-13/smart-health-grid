import fs from "node:fs";
const f = "src/app/(public)/patient/page.tsx";
let s = fs.readFileSync(f, "utf8");
const rep = (a, b) => { if (!s.includes(a)) throw new Error("missing " + a.slice(0, 60)); s = s.replace(a, b); };
rep('import { getI18n } from "@/lib/i18n/server";', 'import { getI18n } from "@/lib/i18n/server";\nimport { todayIST } from "@/lib/dates";\nimport { loadLiveQueues } from "@/lib/operations/live";');
rep("    return { patient, requests, notes };",
`    const today = todayIST();
    const [visit] = await q.query<{ facility_id: string; facility: string; queue_number: number; status: string; ahead: number }>(
      \`select v.facility_id, h.name as facility, v.queue_number, v.status,
              (select count(*)::int from public.visits w where w.facility_id = v.facility_id and w.visit_date = v.visit_date
                 and w.status = 'waiting' and w.queue_number < v.queue_number) as ahead
         from public.visits v join public.health_centres h on h.id = v.facility_id
        where v.patient_id = $1 and v.visit_date = $2::date and v.status in ('waiting', 'in_consultation') limit 1\`,
      [pid, today],
    );
    let wait: number | null = null;
    if (visit && visit.status === "waiting") {
      const lv = (await loadLiveQueues(q, [visit.facility_id], today)).get(visit.facility_id)!;
      const doctors = lv.doctorsVerifiedNow || lv.doctorsRosteredNow;
      wait = doctors ? Math.round(((visit.ahead + 1) / doctors) * lv.consultMinutes) : null;
    }
    return { patient, requests, notes, visit: visit ?? null, wait };`);
rep("      <div className=\"space-y-4\">\n        <Card>\n          <CardHeader title={t(\"patient.requests\")} />",
`      <div className="space-y-4">
        {data.visit && (
          <Notice tone="info">
            <p className="font-semibold">
              {data.visit.facility} · {t("queue.queueNo")} {data.visit.queue_number}
            </p>
            {data.visit.status === "in_consultation" ? (
              <p>{tx("queue.visitStatus.in_consultation")}</p>
            ) : (
              <p>
                {t("patient.queueAhead", { n: data.visit.ahead })} ·{" "}
                {data.wait === null ? t("overload.noDoctor") : t("queue.estWait", { min: data.wait })}
              </p>
            )}
            <p className="text-[11px]">{t("patient.waitDisclaimer")}</p>
          </Notice>
        )}
        <Card>
          <CardHeader title={t("patient.requests")} />`);
fs.writeFileSync(f, s);
console.log("ok");
