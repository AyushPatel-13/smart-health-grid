import type { Metadata } from "next";
import Link from "next/link";
import { TotalsChart } from "@/components/charts/charts";
import { AutoRefresh } from "@/components/forms/queue-forms";
import { KpiCard, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import { withUser } from "@/lib/db";
import { getSnapshots } from "@/lib/data/queries";
import { formatDay, formatNumber, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { hourlyRegistrations, loadLiveQueues, overloadWarnings } from "@/lib/operations/live";

export const metadata: Metadata = { title: "Live load & overload warnings" };

export default async function OverloadPage() {
  const { t, tx, locale } = await getI18n();
  const { user, today, snaps } = await getSnapshots();
  const ids = snaps.map((s) => s.facility.id);
  const [warnings, live, hourly] = await withUser(user.id, async (q) => [
    await overloadWarnings(q, snaps, today),
    await loadLiveQueues(q, ids, today),
    await hourlyRegistrations(q, today),
  ]);
  const name = (id: string) => {
    const f = snaps.find((s) => s.facility.id === id)?.facility;
    return f ? localName(f, locale) : "—";
  };
  const tot = [...live.values()].reduce(
    (a, l) => ({ waiting: a.waiting + l.waiting, checkIns: a.checkIns + l.checkInsToday, booked: a.booked + l.bookedToday, pending: a.pending + l.pendingRegistrations }),
    { waiting: 0, checkIns: 0, booked: 0, pending: 0 },
  );

  return (
    <>
      <AutoRefresh seconds={60} />
      <PageHeader title={t("overload.title")} subtitle={t("overload.subtitle")} />
      <Notice tone="info" className="mb-4">
        {t("overload.signalsNote")}
      </Notice>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <KpiCard label={t("overload.pendingRegs")} value={tot.pending} sub={t("overload.notVisits")} />
        <KpiCard label={t("overload.bookedToday")} value={tot.booked} sub={t("overload.notVisits")} />
        <KpiCard label={t("queue.totalVisits")} value={tot.checkIns} tone="info" />
        <KpiCard label={t("queue.waiting")} value={tot.waiting} tone={tot.waiting ? "warning" : "neutral"} />
        <KpiCard label={t("overload.warnings")} value={warnings.length} tone={warnings.some((w) => w.level === "overload") ? "critical" : warnings.length ? "warning" : "success"} />
      </div>

      <Card className="mt-4">
        <CardHeader title={t("overload.warnings")} subtitle={t("overload.warningsHint")} />
        {warnings.length === 0 ? (
          <EmptyState title={t("overload.none")} />
        ) : (
          <ul className="divide-y divide-line">
            {warnings.map((w) => (
              <li key={`${w.facilityId}-${w.date}`} className="space-y-2 px-4 py-4 sm:px-5">
                <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                  <Badge tone={w.level === "overload" ? "critical" : "warning"}>{tx(`overload.level.${w.level}`)}</Badge>
                  <Link href={`/facilities/${w.facilityId}`} className="text-brand-700 hover:underline">
                    {name(w.facilityId)}
                  </Link>
                  · {formatDay(w.date, locale)} · {Math.round(w.score * 100)}%
                </p>
                <ul className="space-y-0.5 text-[12px] text-ink-muted">
                  {w.signals.map((s, i) => (
                    <li key={i}>• {tx(s.key, s.params)}</li>
                  ))}
                </ul>
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-line p-3 text-[13px]">
                    <p className="font-medium">{t("overload.divert")}</p>
                    {w.divertTo.length === 0 ? (
                      <p className="text-[12px] text-ink-muted">{t("overload.noDivert")}</p>
                    ) : (
                      <ul className="mt-1 space-y-0.5 text-[12px]">
                        {w.divertTo.map((d) => (
                          <li key={d.facilityId}>
                            • {name(d.facilityId)} — {d.km} km · {t("patient.seatsLeft", { n: d.freeSeats })}
                            {d.load !== null && ` · ${t("patient.workload", { pct: Math.round(d.load * 100) })}`}
                            {d.estWaitMinutes !== null && ` · ${t("queue.estWait", { min: d.estWaitMinutes })}`}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-1 text-[11px] text-ink-faint">{t("overload.divertNote")}</p>
                  </div>
                  <div className="rounded-lg border border-line p-3 text-[13px]">
                    <p className="font-medium">{t("overload.staffing")}</p>
                    {w.staffing.length === 0 ? (
                      <p className="text-[12px] text-ink-muted">{t("overload.noStaffing")}</p>
                    ) : (
                      <ul className="mt-1 space-y-0.5 text-[12px]">
                        {w.staffing.map((o) => (
                          <li key={o.shiftId}>
                            • {o.staffName} ({name(o.fromFacilityId)}, {o.distanceKm ?? "?"} km) · +{o.hoursProvided} h
                          </li>
                        ))}
                      </ul>
                    )}
                    <Link href="/workforce" className="mt-1 inline-block text-[12px] text-brand-700 hover:underline">
                      {t("nav.workforce")} →
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader title={t("overload.liveQueues")} subtitle={t("queue.autoRefresh")} />
          <Table>
            <thead>
              <tr>
                <Th>{t("common.facility")}</Th>
                <Th align="right">{t("overload.pendingRegs")}</Th>
                <Th align="right">{t("overload.bookedToday")}</Th>
                <Th align="right">{t("queue.totalVisits")}</Th>
                <Th align="right">{t("queue.waiting")}</Th>
                <Th align="right">{t("overload.doctorsNow")}</Th>
                <Th align="right">{t("overload.estWait")}</Th>
              </tr>
            </thead>
            <tbody>
              {[...live.values()]
                .sort((a, b) => (b.estWaitMinutes ?? 999) - (a.estWaitMinutes ?? 999))
                .map((l) => (
                  <tr key={l.facilityId}>
                    <Td className="text-[13px]">
                      <Link href={`/queue?facility=${l.facilityId}`} className="text-brand-700 hover:underline">
                        {name(l.facilityId)}
                      </Link>
                    </Td>
                    <Td align="right" className="text-ink-muted">{l.pendingRegistrations}</Td>
                    <Td align="right" className="text-ink-muted">{l.bookedToday}</Td>
                    <Td align="right">{l.checkInsToday}</Td>
                    <Td align="right">{l.waiting}</Td>
                    <Td align="right">
                      {l.doctorsVerifiedNow}/{l.doctorsRosteredNow}
                    </Td>
                    <Td align="right">
                      {l.estWaitMinutes === null ? <Badge tone="critical">{t("overload.noDoctor")}</Badge> : `${l.estWaitMinutes} min`}
                      <span className="block text-[10px] text-ink-faint">
                        {tx(`overload.basis.${l.waitBasis}`)} · {l.consultMinutes} min/{tx(`overload.consult.${l.consultMinutesSource}`)}
                      </span>
                    </Td>
                  </tr>
                ))}
            </tbody>
          </Table>
        </Card>
        <Card>
          <CardHeader title={t("overload.hourly")} subtitle={t("overload.notVisits")} />
          <CardBody>
            <TotalsChart data={hourly.map((h) => ({ label: `${String(h.hour).padStart(2, "0")}:00`, value: h.n }))} name={t("overload.pendingRegs")} height={200} />
            <p className="mt-2 text-[11px] text-ink-faint">{formatNumber(hourly.reduce((a, h) => a + h.n, 0))} · {formatDay(today, locale)}</p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
