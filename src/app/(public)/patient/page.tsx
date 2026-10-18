import type { Metadata } from "next";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import { getPatientSession } from "@/lib/auth/patient-session";
import { withSystem } from "@/lib/db";
import { formatDateTime, formatDay, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { todayIST } from "@/lib/dates";
import { loadLiveQueues } from "@/lib/operations/live";
import { AlternativeButton, CancelAppointmentForm, PatientLoginForm, PatientLogoutButton } from "./patient-forms";

export const metadata: Metadata = { title: "My appointments" };

const statusTone: Record<string, "warning" | "success" | "neutral" | "critical" | "info"> = {
  pending: "warning",
  allocated: "success",
  waitlisted: "warning",
  cancelled: "neutral",
  emergency_referred: "critical",
};

export default async function PatientPage() {
  const { t, tx, locale } = await getI18n();
  const pid = await getPatientSession();
  if (!pid) {
    return (
      <>
        <PageHeader title={t("patient.statusTitle")} subtitle={t("patient.statusLogin")} />
        <Card className="max-w-md">
          <CardBody>
            <PatientLoginForm />
          </CardBody>
        </Card>
      </>
    );
  }

  // System context, but every query is filtered to THIS patient only.
  const data = await withSystem(async (q) => {
    const [patient] = await q.query<{ patient_code: string; full_name: string }>(`select patient_code, full_name from public.patients where id = $1`, [pid]);
    const requests = await q.query<{
      id: string; request_code: string; status: string; slot_date: string; start_time: string; service: string; service_hi: string | null;
      service_id: string; cutoff_at: string | null; appointment_id: string | null; appt_status: string | null; facility: string | null;
      facility_hi: string | null; distance_km: number | null; preference_rank: number | null; created_at: string;
    }>(
      `select r.id, r.request_code, r.status, r.slot_date, r.start_time::text as start_time, s.name as service, s.name_hi as service_hi,
              r.service_id, w.cutoff_at, a.id as appointment_id, a.status as appt_status, h.name as facility, h.name_hi as facility_hi,
              a.distance_km, a.preference_rank, r.created_at
         from public.appointment_requests r
         join public.services s on s.id = r.service_id
         left join public.allocation_windows w on w.id = r.window_id
         left join public.appointments a on a.request_id = r.id
         left join public.health_centres h on h.id = a.facility_id
        where r.patient_id = $1
        order by r.created_at desc limit 20`,
      [pid],
    );
    const notes = await q.query<{ id: string; kind: string; params: Record<string, unknown>; created_at: string; request_id: string | null }>(
      `select id, kind, params, created_at, request_id from public.patient_notifications where patient_id = $1 order by created_at desc limit 20`,
      [pid],
    );
    const today = todayIST();
    const [visit] = await q.query<{ facility_id: string; facility: string; queue_number: number; status: string; ahead: number }>(
      `select v.facility_id, h.name as facility, v.queue_number, v.status,
              (select count(*)::int from public.visits w where w.facility_id = v.facility_id and w.visit_date = v.visit_date
                 and w.status = 'waiting' and w.queue_number < v.queue_number) as ahead
         from public.visits v join public.health_centres h on h.id = v.facility_id
        where v.patient_id = $1 and v.visit_date = $2::date and v.status in ('waiting', 'in_consultation') limit 1`,
      [pid, today],
    );
    let wait: number | null = null;
    if (visit && visit.status === "waiting") {
      const lv = (await loadLiveQueues(q, [visit.facility_id], today)).get(visit.facility_id)!;
      const doctors = lv.doctorsVerifiedNow || lv.doctorsRosteredNow;
      wait = doctors ? Math.round(((visit.ahead + 1) / doctors) * lv.consultMinutes) : null;
    }
    return { patient, requests, notes, visit: visit ?? null, wait };
  });
  if (!data.patient) {
    return <EmptyState title={t("patient.invalidAccess")} />;
  }
  const waitNote = data.notes.find((n) => n.kind === "waitlisted" && Array.isArray((n.params as { alternatives?: unknown[] }).alternatives));
  const waitReq = waitNote ? data.requests.find((r) => r.id === waitNote.request_id && r.status === "waitlisted") : null;
  const alternatives = waitReq ? ((waitNote!.params as { alternatives: { facility: string; facilityId: string; date: string; time: string; km: number }[] }).alternatives ?? []) : [];

  return (
    <>
      <PageHeader
        title={t("patient.statusTitle")}
        subtitle={`${data.patient.full_name} · ${t("patient.patientId")}: ${data.patient.patient_code}`}
        actions={<PatientLogoutButton />}
      />
      <div className="space-y-4">
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
          <CardHeader title={t("patient.requests")} />
          {data.requests.length === 0 ? (
            <EmptyState title={t("common.noData")} />
          ) : (
            <ul className="divide-y divide-line">
              {data.requests.map((r) => (
                <li key={r.id} className="space-y-1.5 px-4 py-3 sm:px-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[14px] font-medium">
                      {localName({ name: r.service, name_hi: r.service_hi }, locale)}
                      {r.status !== "emergency_referred" && (
                        <span className="text-ink-muted"> · {formatDay(r.slot_date, locale)} {r.start_time.slice(0, 5)}</span>
                      )}
                    </p>
                    <Badge tone={statusTone[r.status] ?? "neutral"}>{tx(`patient.status.${r.status}`)}</Badge>
                  </div>
                  <p className="font-mono text-[11px] text-ink-faint">{r.request_code}</p>
                  {r.status === "pending" && r.cutoff_at && (
                    <p className="text-[13px] text-ink-muted">{t("patient.pendingInfo", { time: formatDateTime(r.cutoff_at, locale) })}</p>
                  )}
                  {r.appointment_id && r.facility && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-[13px]">
                      <p className="font-medium text-emerald-900">
                        {localName({ name: r.facility, name_hi: r.facility_hi }, locale)} — {formatDay(r.slot_date, locale)} {r.start_time.slice(0, 5)}
                      </p>
                      <p className="text-emerald-800">
                        {t("patient.distance")}: ~{r.distance_km} km ({t("patient.distanceMethod")}) · {tx(`patient.apptStatus.${r.appt_status}`)}
                        {r.preference_rank && r.preference_rank > 1 ? ` · ${t("allocation.choice")} ${r.preference_rank}` : ""}
                      </p>
                      {r.appt_status === "confirmed" && <CancelAppointmentForm appointmentId={r.appointment_id} />}
                    </div>
                  )}
                  {r.status === "emergency_referred" && <Notice tone="critical">{t("patient.emergencyBody")}</Notice>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {waitReq && alternatives.length > 0 && (
          <Card>
            <CardHeader title={t("patient.alternatives")} />
            <ul className="divide-y divide-line">
              {alternatives.map((a) => (
                <li key={`${a.facilityId}-${a.date}-${a.time}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
                  <span className="text-[13px]">
                    {a.facility} · {formatDay(a.date, locale)} {a.time} · ~{a.km} km
                  </span>
                  <AlternativeButton serviceId={waitReq.service_id} date={a.date} time={a.time} facilityId={a.facilityId} />
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <CardHeader title={t("patient.notifications")} />
          <ul className="divide-y divide-line">
            {data.notes.map((n) => {
              const p = n.params as Record<string, string | number | null>;
              return (
                <li key={n.id} className="px-4 py-2.5 text-[13px] sm:px-5">
                  {tx(`patient.notif.${n.kind}`, {
                    ...p,
                    date: typeof p.date === "string" ? formatDay(p.date, locale) : p.date,
                  })}
                  <span className="block text-[11px] text-ink-faint">{formatDateTime(n.created_at, locale)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
