"use client";

import {
  Area,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatNumber, formatShortDay } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

export interface SeriesPoint {
  date: string;
  actual?: number | null;
  forecast?: number | null;
  lower?: number | null;
  upper?: number | null;
}

const AXIS = { fontSize: 11, fill: "#4a5a70" };

/** Historical values (solid) + forecast (dashed) + 80% interval band. */
export function ForecastChart({ data, height = 260, unitLabel }: { data: SeriesPoint[]; height?: number; unitLabel?: string }) {
  const { t, locale } = useI18n();
  const rows = data.map((d) => ({
    ...d,
    label: formatShortDay(d.date, locale),
    band: d.lower != null && d.upper != null ? [d.lower, d.upper] : null,
  }));
  if (!rows.length) return <p className="py-10 text-center text-sm text-ink-muted">{t("common.noData")}</p>;
  return (
    <div style={{ height }} role="img" aria-label={`${t("dashboard.actual")} / ${t("dashboard.forecast")}`}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="#e7ecf3" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: "#dfe5ee" }} minTickGap={24} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => formatNumber(v)} />
          <Tooltip
            formatter={(value, name) => {
              if (Array.isArray(value)) return [`${formatNumber(Number(value[0]))} – ${formatNumber(Number(value[1]))}`, String(name)];
              return [`${formatNumber(Number(value))}${unitLabel ? ` ${unitLabel}` : ""}`, String(name)];
            }}
            contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "#dfe5ee" }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area dataKey="band" name={t("dashboard.forecastBand")} stroke="none" fill="#c9f5ec" fillOpacity={0.8} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="actual" name={t("dashboard.actual")} stroke="#1d55d3" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
          <Line dataKey="forecast" name={t("dashboard.forecast")} stroke="#0e8577" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} isAnimationActive={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface StockRiskRow {
  name: string;
  stock_out: number;
  critical: number;
  high: number;
  low: number;
  ok: number;
  other: number;
}

const RISK_COLORS: Record<keyof Omit<StockRiskRow, "name">, string> = {
  stock_out: "#991b1b",
  critical: "#dc2626",
  high: "#f59e0b",
  low: "#fcd34d",
  ok: "#10b981",
  other: "#cbd5e1",
};

export function StockRiskChart({ data, height = 280 }: { data: StockRiskRow[]; height?: number }) {
  const { t } = useI18n();
  if (!data.length) return <p className="py-10 text-center text-sm text-ink-muted">{t("common.noData")}</p>;
  const keys: (keyof typeof RISK_COLORS)[] = ["stock_out", "critical", "high", "low", "ok", "other"];
  const label = (k: keyof typeof RISK_COLORS) =>
    k === "other" ? `${t("stockRisk.no_consumption")} / ${t("stockRisk.insufficient_data")}` : t(`stockRisk.${k}`);
  return (
    <div style={{ height }} role="img" aria-label={t("dashboard.stockRiskChart")}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="#e7ecf3" vertical={false} />
          <XAxis dataKey="name" tick={AXIS} tickLine={false} axisLine={{ stroke: "#dfe5ee" }} interval={0} angle={-30} textAnchor="end" height={56} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "#dfe5ee" }} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          {keys.map((k) => (
            <Bar key={k} dataKey={k} name={label(k)} stackId="s" fill={RISK_COLORS[k]} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Simple single-series bars (e.g. weekly totals). */
export function TotalsChart({ data, height = 220, name }: { data: { label: string; value: number }[]; height?: number; name: string }) {
  const { t } = useI18n();
  if (!data.length) return <p className="py-10 text-center text-sm text-ink-muted">{t("common.noData")}</p>;
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid stroke="#e7ecf3" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} tickLine={false} axisLine={{ stroke: "#dfe5ee" }} />
          <YAxis tick={AXIS} tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => formatNumber(v)} />
          <Tooltip formatter={(v) => formatNumber(Number(v))} contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "#dfe5ee" }} />
          <Bar dataKey="value" name={name} fill="#1d55d3" radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
