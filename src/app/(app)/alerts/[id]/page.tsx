import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { alertTitle } from "@/components/domain/alert-text";
import { AlertActionsPanel } from "@/components/forms/alert-forms";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, Notice } from "@/components/ui/primitives";
import { alertStatusTone, severityTone } from "@/components/ui/tones";
import { can } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { formatDateTime, formatNumber, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Alert" };

interface AlertDetail {
  id: string;
  facility_id: string;
  facility_name: string;
  facility_name_hi: string | null;
  facility_code: string;
  category: string;
  severity: string;
  status: string;
  source: string;
  title: string;
  explanation: string;
  supporting_values: Record<string, unknown>;
  recommended_action: string | null;
  resource_type: string | null;
  resource_label: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
  last_evaluated_at: string | null;
}

export default async function AlertDetailPage({ params }: PageProps<"/alerts/[id]">) {
  const { id } = await params;
  const { t, tx, locale, dict } = await getI18n();
  const user = await requireUser();
  const valid = /^[0-9a-f-]{36}$/i.test(id);
  const [alert, events, admins] = valid
    ? await withUser(user.id, async (q) => [
        (
          await q.query<AlertDetail>(
            `select a.*, h.name as facility_name, h.name_hi as facility_name_hi, h.code as facility_code, p.full_name as assigned_name
               from public.alerts a join public.health_centres h on h.id = a.facility_id
               left join public.profiles p on p.id = a.assigned_to
              where a.id = $1`,
            [id],
          )
        )[0],
        await q.query<{ id: number; event_type: string; notes: string | null; actor: string | null; created_at: string }>(
          `select e.id, e.event_type, e.notes, p.full_name as actor, e.created_at
             from public.alert_events e left join public.profiles p on p.id = e.actor_id
            where e.alert_id = $1 order by e.created_at, e.id`,
          [id],
        ),
        await q.query<{ id: string; full_name: string }>(
          `select id, full_name from public.profiles where role = 'district_admin' and is_active order by full_name`,
        ),
      ])
    : [undefined, [], []];

  if (!alert) {
    return (
      <Card>
        <EmptyState title={t("alerts.empty")} />
      </Card>
    );
  }
  const values = Object.entries(alert.supporting_values ?? {}).filter(([k]) => !k.endsWith("_hi"));

  return (
    <>
      <Link href="/alerts" className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden />
        {t("alerts.title")}
      </Link>
      <div className="mb-4 flex flex-wrap items-start gap-2">
        <Badge tone={severityTone[alert.severity]}>{t(`severity.${alert.severity as "info"}`)}</Badge>
        <Badge tone={alertStatusTone[alert.status]}>{t(`alertStatus.${alert.status as "open"}`)}</Badge>
        <Badge>{tx(`alerts.categories.${alert.category}`)}</Badge>
        <h1 className="w-full text-xl font-semibold tracking-tight">{alertTitle(alert, locale, tx, dict)}</h1>
        <Link href={`/facilities/${alert.facility_id}`} className="text-[13px] text-brand-700 hover:underline">
          {localName({ name: alert.facility_name, name_hi: alert.facility_name_hi }, locale)} · {alert.facility_code}
        </Link>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader title={t("alerts.explanation")} />
            <CardBody className="space-y-3">
              <p className="text-sm">{alert.explanation}</p>
              {alert.recommended_action && (
                <Notice tone="info">
                  <span className="font-medium">{t("alerts.recommended")}: </span>
                  {alert.recommended_action}
                </Notice>
              )}
              {alert.resolution_notes && (
                <Notice tone="success">
                  <span className="font-medium">{t("alerts.resolutionNotes")}: </span>
                  {alert.resolution_notes}
                </Notice>
              )}
            </CardBody>
          </Card>
          {values.length > 0 && (
            <Card>
              <CardHeader title={t("alerts.supporting")} />
              <CardBody>
                <DefinitionList
                  items={values.map(([k, v]) => ({
                    label: <span className="font-mono text-[12px]">{k}</span>,
                    value: v === null ? "—" : typeof v === "number" ? formatNumber(v) : String(v),
                  }))}
                />
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title={t("alerts.history")} />
            <ol className="relative mx-5 my-4 border-l border-line">
              {events.map((e) => (
                <li key={e.id} className="mb-4 ml-4">
                  <span className="absolute -left-1.5 mt-1.5 size-3 rounded-full border-2 border-white bg-brand-500" aria-hidden />
                  <p className="text-[13px] font-medium">{tx(`alerts.events.${e.event_type}`)}</p>
                  <p className="text-[12px] text-ink-muted">
                    {e.actor ?? t("audit.system")} · {formatDateTime(e.created_at, locale)}
                  </p>
                  {e.notes && <p className="mt-0.5 text-[13px]">{e.notes}</p>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title={t("common.details")} />
            <CardBody>
              <DefinitionList
                className="sm:grid-cols-1"
                items={[
                  { label: t("alerts.resource"), value: alert.resource_label ?? "—" },
                  { label: t("alerts.source"), value: alert.source === "manual" ? t("alerts.sourceManual") : t("alerts.sourceRule") },
                  { label: t("alerts.assigned"), value: alert.assigned_name ?? t("alerts.unassigned") },
                  { label: t("alerts.created"), value: formatDateTime(alert.created_at, locale) },
                  { label: t("alerts.updated"), value: formatDateTime(alert.updated_at, locale) },
                ]}
              />
            </CardBody>
          </Card>
          {can(user, "alerts:manage") ? (
            <Card>
              <CardHeader title={t("common.actions")} />
              <CardBody>
                <AlertActionsPanel
                  alertId={alert.id}
                  status={alert.status}
                  currentAssignee={alert.assigned_to}
                  admins={admins.map((a) => ({ id: a.id, name: a.full_name }))}
                />
              </CardBody>
            </Card>
          ) : (
            <Notice tone="info">{t("common.readOnlyNotice")}</Notice>
          )}
        </div>
      </div>
    </>
  );
}
