import type { Metadata } from "next";
import Link from "next/link";
import { UserPlus } from "lucide-react";
import { AutoRefresh, CheckInButton, StaffCancelAppointment, VisitActions, WalkInForm } from "@/components/forms/queue-forms";
import { FilterForm, FilterSelect, KpiCard, Table, Td, Th } from "@/components/ui/data";
import { Badge, ButtonLink, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { canWriteFacility } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { addDays, todayIST } from "@/lib/dates";
import { getFacilityDirectory } from "@/lib/data/queries";
import { formatDateTime, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { loadLiveQueues } from "@/lib/operations/live";

export const metadata: Metadata = { title: "Check-in & queue" };

const visitTone: Record<string, "warning" | "info" | "success" | "neutral"> = {
  waiting: "warning",
  in_consultation: "info",
  completed: "success",
  cancelled: "neutral",
  left_without_care: "neutral",
};

export default async function QueuePage({ searchParams }: PageProps<"/queue">) {
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, tx, locale } = await getI18n();
  const user = await requireUser();
  const directory = await getFacilityDirectory();
  const facilityId =
    user.role === "facility_staff" ? user.facilityId! : directory.find((d) => d.id === sp.facility)?.id ?? directory[0]?.id;
  if (!facilityId) return <EmptyState title={t("empty.noAccess")} />;
  const today = todayIST();
  const canWrite = canWriteFacility(user, facilityId);

  const [appts, visits, [tomorrow]] = await withUser(user.id, async (q) => [
    await q.query<{ id: string; status: string; start_time: string; distance_km: number; patient_code: string | null; full_name: string | null; service: string; service_hi: string | null }>(
      `select a.id, a.status, a.start_time::text as start_time, a.distance_km, p.patient_code, p.full_name, s.name as service, s.name_hi as service_hi
         from public.appointments a
         join public.services s on s.id = a.service_id
         left join public.patients p on p.id = a.patient_id
        where a.facility_id = $1 and a.slot_date = $2::date and a.status <> 'cancelled'
        order by a.start_time, a.rank_at_facility`,
      [facilityId, today],
    ),
    await q.query<{ id: string; queue_number: number; status: string; checked_in_at: string; patient_code: string | null; full_name: string | null; appointment_id: string | null }>(
      `select v.id, v.queue_number, v.status, v.checked_in_at, p.patient_code, p.full_name, v.appointment_id
         from public.visits v left join public.patients p on p.id = v.patient_id
        where v.facility_id = $1 and v.visit_date = $2::date order by v.queue_number`,
      [facilityId, today],
    ),
    await q.query<{ n: number }>(
      `select count(*)::int as n from public.appointments where facility_id = $1 and slot_date = $2::date and status = 'confirmed'`,
      [facilityId, addDays(today, 1)],
    ),
  ]);
  const active = visits.filter((v) => v.status !== "cancelled");
  const live = (await withUser(user.id, (q) => loadLiveQueues(q, [facilityId], today))).get(facilityId)!;
  const count = (s: string) => visits.filter((v) => v.status === s).length;
  const fac = directory.find((d) => d.id === facilityId);

  return (
    <>
      <AutoRefresh seconds={20} />
      <PageHeader
        title={`${t("queue.title")}${fac ? ` · ${localName(fac, locale)}` : ""}`}
        subtitle={`${t("queue.subtitle")} ${t("queue.autoRefresh")}.`}
        actions={
          canWrite && (
            <ButtonLink href="/register" variant="secondary">
              <UserPlus className="size-4" aria-hidden />
              {t("queue.registerPatient")}
            </ButtonLink>
          )
        }
      />
      {user.role !== "facility_staff" && (
        <FilterForm applyLabel={t("common.apply")} resetHref="/queue" resetLabel={t("common.reset")}>
          <FilterSelect name="facility" label={t("queue.selectFacility")} value={facilityId} options={directory.map((d) => ({ value: d.id, label: localName(d, locale) }))} />
        </FilterForm>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <KpiCard label={t("queue.totalVisits")} value={active.length} tone="info" />
        <KpiCard label={t("queue.waiting")} value={count("waiting")} tone="warning" />
        <KpiCard label={t("queue.inConsultation")} value={count("in_consultation")} tone="teal" />
        <KpiCard label={t("queue.completed")} value={count("completed")} tone="success" />
        <KpiCard label={t("queue.expectedTomorrow")} value={tomorrow.n} sub={t("queue.bookings")} />
        <KpiCard
          label={t("overload.estWait")}
          value={live.estWaitMinutes === null ? "—" : `${live.estWaitMinutes} min`}
          sub={`${tx(`overload.basis.${live.waitBasis}`)} · ${live.doctorsVerifiedNow}/${live.doctorsRosteredNow} · ${live.consultMinutes} min/${tx(`overload.consult.${live.consultMinutesSource}`)}`}
          tone={live.estWaitMinutes === null ? "critical" : live.estWaitMinutes > 60 ? "warning" : "teal"}
        />
      </div>

      {canWrite && (
        <Card className="mt-4">
          <CardHeader title={t("queue.walkIn")} />
          <CardBody>
            <WalkInForm facilityId={facilityId} />
          </CardBody>
        </Card>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("queue.queue")} />
          {visits.length === 0 ? (
            <EmptyState title={t("queue.noQueue")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("queue.queueNo")}</Th>
                  <Th>{t("queue.patientCode")}</Th>
                  <Th>{t("common.status")}</Th>
                  {canWrite && <Th align="right">{t("common.actions")}</Th>}
                </tr>
              </thead>
              <tbody>
                {visits.map((v) => (
                  <tr key={v.id}>
                    <Td className="tabular text-lg font-semibold">{v.queue_number}</Td>
                    <Td>
                      <span className="font-mono text-[12px]">{v.patient_code}</span>
                      <span className="block text-[12px] text-ink-muted">{v.full_name}</span>
                      <span className="block text-[11px] text-ink-faint">{formatDateTime(v.checked_in_at, locale)}</span>
                    </Td>
                    <Td>
                      <Badge tone={visitTone[v.status]}>{tx(`queue.visitStatus.${v.status}`)}</Badge>
                    </Td>
                    {canWrite && (
                      <Td align="right">
                        <VisitActions visitId={v.id} status={v.status} />
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title={t("queue.appointments")} />
          {appts.length === 0 ? (
            <EmptyState title={t("queue.noAppointments")} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>{t("patient.time")}</Th>
                  <Th>{t("queue.patientCode")}</Th>
                  <Th>{t("common.status")}</Th>
                  {canWrite && <Th align="right">{t("common.actions")}</Th>}
                </tr>
              </thead>
              <tbody>
                {appts.map((a) => (
                  <tr key={a.id}>
                    <Td className="whitespace-nowrap">
                      {a.start_time.slice(0, 5)}
                      <span className="block text-[11px] text-ink-muted">{localName({ name: a.service, name_hi: a.service_hi }, locale)}</span>
                    </Td>
                    <Td>
                      <span className="font-mono text-[12px]">{a.patient_code}</span>
                      <span className="block text-[12px] text-ink-muted">
                        {a.full_name} · ~{a.distance_km} km
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={a.status === "confirmed" ? "info" : a.status === "completed" ? "success" : "warning"}>{tx(`patient.apptStatus.${a.status}`)}</Badge>
                    </Td>
                    {canWrite && (
                      <Td align="right">
                        {a.status === "confirmed" && a.patient_code && (
                          <div className="flex flex-col items-end gap-1">
                            <CheckInButton facilityId={facilityId} patientCode={a.patient_code} appointmentId={a.id} />
                            <StaffCancelAppointment appointmentId={a.id} />
                          </div>
                        )}
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <p className="mt-3 text-[12px] text-ink-muted">
        <Link href={`/facilities/${facilityId}?tab=patients`} className="text-brand-700 hover:underline">
          {t("footfall.title")} →
        </Link>
      </p>
    </>
  );
}
