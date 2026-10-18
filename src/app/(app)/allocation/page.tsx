import type { Metadata } from "next";
import Link from "next/link";
import { CloseWindowButton, RunDueButton } from "@/components/forms/queue-forms";
import { KpiCard, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { ALLOCATION_RULES } from "@/lib/config/rules";
import { requireRole } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { todayIST } from "@/lib/dates";
import { formatDateTime, formatDay, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Appointment allocation" };

const winTone: Record<string, "info" | "warning" | "success" | "critical"> = { open: "info", processing: "warning", completed: "success", failed: "critical" };
const outTone: Record<string, "success" | "warning" | "neutral" | "critical" | "info"> = {
  allocated: "success",
  reallocated: "success",
  rejected_capacity: "warning",
  waitlisted: "critical",
  ineligible: "neutral",
  emergency: "critical",
  cancelled: "neutral",
};

export default async function AllocationPage({ searchParams }: PageProps<"/allocation">) {
  const user = await requireRole("district_admin");
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, tx, locale } = await getI18n();
  const today = todayIST();

  const [windows, pendingBy, waitlisted, slots] = await withUser(user.id, async (q) => [
    await q.query<{ id: string; window_start: string; cutoff_at: string; status: string; attempts: number; last_error: string | null; triggered_by: string | null; processed_at: string | null; summary: { requests?: number; allocated?: number; waitlisted?: number; firstChoice?: number } }>(
      `select id, window_start, cutoff_at, status, attempts, last_error, triggered_by, processed_at, summary
         from public.allocation_windows order by window_start desc limit 20`,
    ),
    await q.query<{ window_id: string; n: number }>(
      `select window_id, count(*)::int as n from public.appointment_requests where status = 'pending' and window_id is not null group by 1`,
    ),
    await q.query<{ id: string; request_code: string; patient_code: string | null; service: string; service_hi: string | null; slot_date: string; start_time: string; decided_at: string | null }>(
      `select r.id, r.request_code, p.patient_code, s.name as service, s.name_hi as service_hi, r.slot_date, r.start_time::text as start_time, r.decided_at
         from public.appointment_requests r join public.services s on s.id = r.service_id left join public.patients p on p.id = r.patient_id
        where r.status = 'waitlisted' order by r.slot_date, r.start_time limit 50`,
    ),
    await q.query<{ service: string; service_hi: string | null; slot_date: string; capacity: number; allocated: number }>(
      `select s.name as service, s.name_hi as service_hi, sl.slot_date, sum(sl.capacity)::int as capacity, sum(sl.allocated)::int as allocated
         from public.appointment_slots sl join public.services s on s.id = sl.service_id
        where sl.slot_date >= $1::date group by 1, 2, 3 order by 3, 1`,
      [today],
    ),
  ]);
  const pending = new Map(pendingBy.map((p) => [p.window_id, p.n]));
  const open = windows.find((w) => w.status === "open");
  const selected = windows.find((w) => w.id === sp.window) ?? windows.find((w) => w.status === "completed");
  const decisions = selected
    ? await withUser(user.id, (q) =>
        q.query<{ id: number; request_code: string; patient_code: string | null; facility: string | null; facility_hi: string | null; distance_km: number | null; preference_rank: number | null; rank_at_facility: number | null; outcome: string; reason: string }>(
          `select d.id, r.request_code, p.patient_code, h.name as facility, h.name_hi as facility_hi, d.distance_km, d.preference_rank,
                  d.rank_at_facility, d.outcome, d.reason
             from public.allocation_decisions d
             join public.appointment_requests r on r.id = d.request_id
             left join public.patients p on p.id = r.patient_id
             left join public.health_centres h on h.id = d.facility_id
            where d.window_id = $1 order by h.name nulls last, d.outcome, d.distance_km`,
          [selected.id],
        ),
      )
    : [];

  return (
    <>
      <PageHeader title={t("allocation.title")} subtitle={t("allocation.subtitle")} actions={<RunDueButton />} />
      <Card className="mb-4">
        <CardHeader title={t("allocation.policyTitle")} subtitle={`${t("allocation.windowMinutes", { n: ALLOCATION_RULES.windowMinutes })} · ${t("allocation.scheduler")}`} />
        <CardBody>
          <p className="text-[13px] text-ink-muted">{t("allocation.policyBody", { km: ALLOCATION_RULES.maxDistanceKm })}</p>
        </CardBody>
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader title={t("allocation.openWindows")} />
          <CardBody className="space-y-3">
            {open ? (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <KpiCard label={t("allocation.pending")} value={pending.get(open.id) ?? 0} tone="warning" />
                  <KpiCard label={t("allocation.cutoff")} value={formatDateTime(open.cutoff_at, locale).split(", ").pop()} sub={formatDateTime(open.cutoff_at, locale)} />
                </div>
                <CloseWindowButton windowId={open.id} />
              </>
            ) : (
              <p className="text-sm text-ink-muted">{t("allocation.none")}</p>
            )}
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title={t("allocation.slots")} />
          <Table>
            <thead>
              <tr>
                <Th>{t("common.date")}</Th>
                <Th>{t("patient.service")}</Th>
                <Th align="right">{t("allocation.allocated")}</Th>
              </tr>
            </thead>
            <tbody>
              {slots.map((s) => (
                <tr key={`${s.slot_date}-${s.service}`}>
                  <Td className="whitespace-nowrap text-[13px]">{formatDay(s.slot_date, locale)}</Td>
                  <Td className="text-[13px]">{localName({ name: s.service, name_hi: s.service_hi }, locale)}</Td>
                  <Td align="right">
                    {s.allocated} / {s.capacity}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title={t("allocation.batches")} />
        {windows.length === 0 ? (
          <EmptyState title={t("allocation.none")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("allocation.cutoff")}</Th>
                <Th>{t("common.status")}</Th>
                <Th align="right">{t("allocation.pending")}</Th>
                <Th align="right">{t("allocation.allocated")}</Th>
                <Th align="right">{t("allocation.waitlisted")}</Th>
                <Th align="right">{t("allocation.firstChoice")}</Th>
                <Th align="right">{t("allocation.attempts")}</Th>
                <Th>{t("allocation.triggeredBy")}</Th>
                <Th>
                  <span className="sr-only">{t("common.actions")}</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {windows.map((w) => (
                <tr key={w.id} className={selected?.id === w.id ? "bg-brand-50/50" : ""}>
                  <Td className="whitespace-nowrap text-[13px]">{formatDateTime(w.cutoff_at, locale)}</Td>
                  <Td>
                    <Badge tone={winTone[w.status]}>{tx(`allocation.status.${w.status}`)}</Badge>
                    {w.last_error && <span className="block max-w-[220px] truncate text-[11px] text-red-700" title={w.last_error}>{t("allocation.lastError")}: {w.last_error}</span>}
                  </Td>
                  <Td align="right">{pending.get(w.id) ?? (w.summary.requests ?? 0)}</Td>
                  <Td align="right">{w.summary.allocated ?? "—"}</Td>
                  <Td align="right">{w.summary.waitlisted ?? "—"}</Td>
                  <Td align="right">{w.summary.firstChoice ?? "—"}</Td>
                  <Td align="right">{w.attempts}</Td>
                  <Td className="text-[12px] text-ink-muted">{w.triggered_by ?? "—"}</Td>
                  <Td align="right">
                    {w.status === "failed" ? (
                      <RunDueButton label={t("allocation.retry")} />
                    ) : w.status === "completed" ? (
                      <Link href={`/allocation?window=${w.id}`} className="text-[13px] text-brand-700 hover:underline">
                        {t("allocation.viewBatch")}
                      </Link>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {selected && (
        <Card className="mt-4">
          <CardHeader title={`${t("allocation.audit")} · ${formatDateTime(selected.cutoff_at, locale)}`} subtitle={t("allocation.auditHint")} />
          {decisions.length === 0 ? (
            <EmptyState title={t("common.noData")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("allocation.request")}</Th>
                  <Th>{t("common.facility")}</Th>
                  <Th align="right">{t("patient.distance")}</Th>
                  <Th align="right">{t("allocation.choice")}</Th>
                  <Th align="right">{t("allocation.rankAtCentre")}</Th>
                  <Th>{t("common.status")}</Th>
                  <Th>{t("common.reason")}</Th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <tr key={d.id}>
                    <Td>
                      <span className="font-mono text-[12px]">{d.patient_code}</span>
                      <span className="block font-mono text-[11px] text-ink-faint">{d.request_code}</span>
                    </Td>
                    <Td className="text-[13px]">{d.facility ? localName({ name: d.facility, name_hi: d.facility_hi }, locale) : "—"}</Td>
                    <Td align="right">{d.distance_km === null ? "—" : `${d.distance_km} km`}</Td>
                    <Td align="right">{d.preference_rank ?? "—"}</Td>
                    <Td align="right">{d.rank_at_facility ?? "—"}</Td>
                    <Td>
                      <Badge tone={outTone[d.outcome]}>{tx(`allocation.outcome.${d.outcome}`)}</Badge>
                    </Td>
                    <Td className="max-w-sm text-[12px] text-ink-muted">{d.reason}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader title={t("allocation.unallocated")} />
        {waitlisted.length === 0 ? (
          <EmptyState title={t("common.noData")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("allocation.request")}</Th>
                <Th>{t("patient.service")}</Th>
                <Th>{t("common.date")}</Th>
              </tr>
            </thead>
            <tbody>
              {waitlisted.map((w) => (
                <tr key={w.id}>
                  <Td>
                    <span className="font-mono text-[12px]">{w.patient_code}</span>
                    <span className="block font-mono text-[11px] text-ink-faint">{w.request_code}</span>
                  </Td>
                  <Td className="text-[13px]">{localName({ name: w.service, name_hi: w.service_hi }, locale)}</Td>
                  <Td className="whitespace-nowrap text-[13px]">
                    {formatDay(w.slot_date, locale)} {w.start_time.slice(0, 5)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
