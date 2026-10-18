import Link from "next/link";
import { RISK_BANDS } from "@/lib/config/rules";
import type { RiskScore } from "@/lib/analytics/risk";
import type { Reason } from "@/lib/analytics/stock";
import { formatNumber, formatRelative, localName, type Locale, type TFunction, type TxFunction } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n/en";
import { Badge, Meter, cn } from "@/components/ui/primitives";
import { riskBandTone, severityTone, alertStatusTone } from "@/components/ui/tones";
import { alertTitle } from "./alert-text";

export function RiskBadge({ risk, t }: { risk: Pick<RiskScore, "score" | "band">; t: TFunction }) {
  return (
    <Badge tone={riskBandTone[risk.band]} title={t(`riskBand.${risk.band}`)}>
      <span className="tabular font-semibold">{risk.score}</span>
      <span className="hidden sm:inline">· {t(`riskBand.${risk.band}`)}</span>
    </Badge>
  );
}

/** Transparent factor-by-factor breakdown of a facility risk score. */
export function RiskBreakdown({ risk, t, compact }: { risk: RiskScore; t: TFunction; compact?: boolean }) {
  return (
    <div className="space-y-2.5">
      {risk.factors.map((f) => {
        const inputs = Object.entries(f.inputs)
          .map(([k, v]) => `${t(`risk.inputs.${k}` as never)}: ${v === null ? "—" : typeof v === "number" ? formatNumber(v) : v}`)
          .join(" · ");
        const tone = f.normalized === null ? "neutral" : f.normalized >= 0.66 ? "critical" : f.normalized >= 0.33 ? "warning" : "success";
        return (
          <div key={f.key}>
            <div className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="font-medium text-ink">{t(`risk.factors.${f.key}`)}</span>
              <span className="tabular shrink-0 text-ink-muted">
                {f.normalized === null ? (
                  <Badge tone="neutral">{t("risk.missing")}</Badge>
                ) : (
                  <>
                    <span className="font-semibold text-ink">{formatNumber(f.contribution)}</span> / {f.weight}
                  </>
                )}
              </span>
            </div>
            <Meter value={f.normalized} tone={tone} label={t(`risk.factors.${f.key}`)} />
            {!compact && (
              <p className="mt-1 text-[11px] text-ink-muted">
                {inputs}
                <span className="block font-mono text-[10.5px] text-ink-faint">{t(`risk.formulas.${f.key}`)}</span>
              </p>
            )}
          </div>
        );
      })}
      {!compact && (
        <p className="pt-1 text-[11px] text-ink-faint">{t("risk.methodBody", { high: RISK_BANDS.high, medium: RISK_BANDS.medium })}</p>
      )}
    </div>
  );
}

export function ReasonList({ reasons, tx, className }: { reasons: Reason[]; tx: TxFunction; className?: string }) {
  if (!reasons.length) return null;
  return (
    <ul className={cn("space-y-0.5 text-[12px] text-ink-muted", className)}>
      {reasons.map((r, i) => (
        <li key={i}>• {tx(r.key, r.params)}</li>
      ))}
    </ul>
  );
}

export interface AlertRow {
  id: string;
  facility_id: string;
  facility_name: string;
  facility_name_hi: string | null;
  category: string;
  severity: string;
  status: string;
  title: string;
  supporting_values: Record<string, unknown> | null;
  recommended_action: string | null;
  assigned_name: string | null;
  created_at: string;
  updated_at: string;
  source: string;
}

export const ALERT_SELECT = `
  select a.id, a.facility_id, h.name as facility_name, h.name_hi as facility_name_hi, a.category, a.severity, a.status,
         a.title, a.supporting_values, a.recommended_action, p.full_name as assigned_name, a.created_at, a.updated_at, a.source
    from public.alerts a
    join public.health_centres h on h.id = a.facility_id
    left join public.profiles p on p.id = a.assigned_to`;

export function AlertListCompact({
  alerts,
  t,
  tx,
  locale,
  dict,
  showFacility = true,
}: {
  alerts: AlertRow[];
  t: TFunction;
  tx: TxFunction;
  locale: Locale;
  dict: Dictionary;
  showFacility?: boolean;
}) {
  return (
    <ul className="divide-y divide-line">
      {alerts.map((a) => (
        <li key={a.id}>
          <Link href={`/alerts/${a.id}`} className="flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50 sm:px-5">
            <Badge tone={severityTone[a.severity]} className="mt-0.5">
              {t(`severity.${a.severity as "critical"}`)}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-ink">{alertTitle(a, locale, tx, dict)}</p>
              <p className="text-[12px] text-ink-muted">
                {showFacility && <>{localName({ name: a.facility_name, name_hi: a.facility_name_hi }, locale)} · </>}
                {tx(`alerts.categories.${a.category}`)} · {formatRelative(a.created_at, t)}
              </p>
            </div>
            <Badge tone={alertStatusTone[a.status]} className="mt-0.5 hidden sm:inline-flex">
              {t(`alertStatus.${a.status as "open"}`)}
            </Badge>
          </Link>
        </li>
      ))}
    </ul>
  );
}
