import type { Metadata } from "next";
import Link from "next/link";
import { FilterForm, FilterSelect } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, PageHeader, cn } from "@/components/ui/primitives";
import { withUser } from "@/lib/db";
import { getDistricts, getSnapshots } from "@/lib/data/queries";
import type { FacilitySnapshot } from "@/lib/data/snapshot";
import { formatNumber, formatPct, formatRelative, localName, type TFunction } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { loadLiveQueues, overloadWarnings, type LiveLoad } from "@/lib/operations/live";

export const metadata: Metadata = { title: "District digital twin" };

const LAYERS = ["risk", "demand", "stock", "beds", "doctors", "diagnostics", "alerts"] as const;
type Layer = (typeof LAYERS)[number];
type Level = "good" | "watch" | "critical" | "nodata";
const COLOR: Record<Level, string> = { good: "#10b981", watch: "#f59e0b", critical: "#dc2626", nodata: "#94a3b8" };

function levelFor(layer: Layer, s: FacilitySnapshot, live: LiveLoad | undefined): { level: Level; value: string } {
  switch (layer) {
    case "risk":
      return { level: s.risk.band === "high" ? "critical" : s.risk.band === "medium" ? "watch" : "good", value: String(s.risk.score) };
    case "demand": {
      const avg = s.footfall.series.length ? s.footfall.last7Total / 7 : null;
      if (avg === null) return { level: "nodata", value: "—" };
      const r = avg / s.facility.opd_capacity_per_day;
      return { level: r >= 1 ? "critical" : r >= 0.85 ? "watch" : "good", value: formatPct(r) };
    }
    case "stock": {
      const crit = s.stockCounts.stock_out + s.stockCounts.critical;
      return { level: crit ? "critical" : s.stockCounts.high + s.stockCounts.low ? "watch" : "good", value: String(crit + s.stockCounts.high) };
    }
    case "beds":
      return s.beds.utilization === null
        ? { level: "nodata", value: "—" }
        : { level: s.beds.available === 0 ? "critical" : s.beds.utilization >= 0.9 ? "watch" : "good", value: `${s.beds.available}/${s.beds.total}` };
    case "doctors": {
      if (!live) return { level: "nodata", value: "—" };
      const v = live.doctorsVerifiedNow;
      return {
        level: live.doctorsRosteredNow === 0 ? "nodata" : v === 0 ? "critical" : v < live.doctorsRosteredNow ? "watch" : "good",
        value: `${v}/${live.doctorsRosteredNow}`,
      };
    }
    case "diagnostics":
      return { level: s.diagnostics.essentialUnavailable ? "critical" : s.diagnostics.unavailable || s.diagnostics.stale ? "watch" : "good", value: String(s.diagnostics.unavailable) };
    case "alerts":
      return { level: s.alerts.critical ? "critical" : s.alerts.warning ? "watch" : "good", value: String(s.alerts.open) };
  }
}

function levelLabel(t: TFunction, l: Level) {
  return t(`twin.level.${l}`);
}

export default async function TwinPage({ searchParams }: PageProps<"/twin">) {
  const sp = (await searchParams) as Record<string, string | undefined>;
  const { t, locale } = await getI18n();
  const { user, today, snaps } = await getSnapshots();
  const districts = await getDistricts();
  const layer: Layer = LAYERS.includes(sp.layer as Layer) ? (sp.layer as Layer) : "risk";
  const shown = snaps.filter(
    (s) =>
      (!sp.type || s.facility.facility_type === sp.type) &&
      (!sp.district || s.facility.district_id === sp.district) &&
      (!sp.band || s.risk.band === sp.band) &&
      s.facility.latitude != null,
  );
  const [live, warnings] = await withUser(user.id, async (q) => [
    await loadLiveQueues(q, snaps.map((s) => s.facility.id), today),
    await overloadWarnings(q, snaps, today),
  ]);
  const selected = shown.find((s) => s.facility.id === sp.f) ?? null;

  // Equirectangular projection fitted to the visible facilities.
  const W = 800;
  const H = 520;
  const lats = shown.map((s) => s.facility.latitude!);
  const lons = shown.map((s) => s.facility.longitude!);
  const pad = 0.03;
  const minLat = Math.min(...lats) - pad, maxLat = Math.max(...lats) + pad;
  const minLon = Math.min(...lons) - pad, maxLon = Math.max(...lons) + pad;
  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const scale = Math.min(W / ((maxLon - minLon) * kx || 1), H / (maxLat - minLat || 1));
  const proj = (lat: number, lon: number) => ({
    x: (W - (maxLon - minLon) * kx * scale) / 2 + (lon - minLon) * kx * scale,
    y: (H - (maxLat - minLat) * scale) / 2 + (maxLat - lat) * scale,
  });
  const kmPerPx = 111.32 / scale;
  const scaleKm = 5;

  const qs = (extra: Record<string, string | undefined>) =>
    `/twin?${new URLSearchParams(Object.entries({ ...sp, ...extra }).filter(([, v]) => v) as [string, string][])}`;

  return (
    <>
      <PageHeader title={t("twin.title")} subtitle={t("twin.subtitle")} />
      <FilterForm applyLabel={t("common.apply")} resetHref="/twin" resetLabel={t("common.reset")}>
        <FilterSelect name="layer" label={t("twin.layer")} value={layer} options={LAYERS.map((l) => ({ value: l, label: t(`twin.layers.${l}`) }))} />
        {districts.length > 1 && (
          <FilterSelect name="district" label={t("common.district")} value={sp.district} options={[{ value: "", label: t("common.all") }, ...districts.map((d) => ({ value: d.id, label: localName(d, locale) }))]} />
        )}
        <FilterSelect name="type" label={t("common.type")} value={sp.type} options={[{ value: "", label: t("common.all") }, { value: "PHC", label: "PHC" }, { value: "CHC", label: "CHC" }]} />
        <FilterSelect
          name="band"
          label={t("facilities.filterRisk")}
          value={sp.band}
          options={[{ value: "", label: t("common.all") }, ...(["high", "medium", "low"] as const).map((b) => ({ value: b, label: t(`riskBand.${b}`) }))]}
        />
        {sp.f && <input type="hidden" name="f" value={sp.f} />}
      </FilterForm>

      {shown.length === 0 ? (
        <Card>
          <EmptyState title={t("facilities.empty")} />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="xl:col-span-2">
            <CardHeader title={t(`twin.layers.${layer}`)} subtitle={t("twin.mapNote")} />
            <CardBody>
              <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full rounded-lg bg-[#f2f6fb]" role="img" aria-label={t("twin.title")}>
                <defs>
                  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                    <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e2e8f0" strokeWidth="1" />
                  </pattern>
                </defs>
                <rect width={W} height={H} fill="url(#grid)" />
                {shown.map((s) => {
                  const p = proj(s.facility.latitude!, s.facility.longitude!);
                  const lv = levelFor(layer, s, live.get(s.facility.id));
                  const avg = s.footfall.series.length ? s.footfall.last7Total / 7 : 30;
                  const r = 9 + Math.sqrt(avg) * 1.4;
                  const warn = warnings.find((w) => w.facilityId === s.facility.id);
                  const isSel = selected?.facility.id === s.facility.id;
                  return (
                    <a key={s.facility.id} href={qs({ f: s.facility.id })} aria-label={`${s.facility.name}: ${levelLabel(t, lv.level)} (${lv.value})`}>
                      {warn && <circle cx={p.x} cy={p.y} r={r + 7} fill="none" stroke={warn.level === "overload" ? "#dc2626" : "#f59e0b"} strokeWidth="2.5" strokeDasharray="5 3" />}
                      <circle cx={p.x} cy={p.y} r={r} fill={COLOR[lv.level]} fillOpacity={0.85} stroke={isSel ? "#0b1f3a" : "#fff"} strokeWidth={isSel ? 3 : 2} />
                      {s.facility.facility_type === "CHC" && <circle cx={p.x} cy={p.y} r={r - 4} fill="none" stroke="#fff" strokeWidth="1.5" />}
                      <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff">
                        {lv.value}
                      </text>
                      <text x={p.x} y={p.y + r + 14} textAnchor="middle" fontSize="11" fill="#0f1b2d">
                        {localName(s.facility, locale).replace(/^(PHC|CHC|प्रा\.स्वा\.के\.|सा\.स्वा\.के\.) /, "")}
                      </text>
                    </a>
                  );
                })}
                <g transform={`translate(${W - 20 - scaleKm / kmPerPx}, ${H - 24})`}>
                  <rect width={scaleKm / kmPerPx} height="4" fill="#0f1b2d" />
                  <text x={scaleKm / kmPerPx / 2} y="-4" textAnchor="middle" fontSize="11" fill="#0f1b2d">
                    {scaleKm} km
                  </text>
                </g>
              </svg>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px]">
                {(["good", "watch", "critical", "nodata"] as Level[]).map((l) => (
                  <span key={l} className="inline-flex items-center gap-1">
                    <span className="inline-block size-3 rounded-full" style={{ background: COLOR[l] }} aria-hidden />
                    {levelLabel(t, l)}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block size-3 rounded-full border-2 border-dashed border-red-600" aria-hidden />
                  {t("twin.overloadRing")}
                </span>
                <span className="text-ink-muted">{t("twin.sizeNote")}</span>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={selected ? localName(selected.facility, locale) : t("twin.selectHint")} />
            <CardBody>
              {selected ? (
                <FacilityPanel s={selected} live={live.get(selected.facility.id)} warning={warnings.find((w) => w.facilityId === selected.facility.id)?.level ?? null} t={t} />
              ) : (
                <ul className="space-y-1.5 text-[13px]">
                  {shown
                    .map((s) => ({ s, lv: levelFor(layer, s, live.get(s.facility.id)) }))
                    .sort((a, b) => ["critical", "watch", "nodata", "good"].indexOf(a.lv.level) - ["critical", "watch", "nodata", "good"].indexOf(b.lv.level))
                    .map(({ s, lv }) => (
                      <li key={s.facility.id}>
                        <Link href={qs({ f: s.facility.id })} className="flex items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-slate-50">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-block size-2.5 rounded-full" style={{ background: COLOR[lv.level] }} aria-hidden />
                            {localName(s.facility, locale)}
                          </span>
                          <span className="tabular text-ink-muted">{lv.value}</span>
                        </Link>
                      </li>
                    ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}

function FacilityPanel({ s, live, warning, t }: { s: FacilitySnapshot; live: LiveLoad | undefined; warning: string | null; t: TFunction }) {
  const row = (layer: Layer) => levelFor(layer, s, live);
  const chip = (layer: Layer) => {
    const r = row(layer);
    return (
      <span className={cn("inline-flex items-center gap-1")}>
        <span className="inline-block size-2.5 rounded-full" style={{ background: COLOR[r.level] }} aria-hidden />
        {r.value} · {t(`twin.level.${r.level}`)}
      </span>
    );
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <Badge tone="navy">{s.facility.facility_type}</Badge>
        <Badge tone={s.risk.band === "high" ? "critical" : s.risk.band === "medium" ? "warning" : "success"}>
          {t("risk.score")} {s.risk.score}
        </Badge>
        {warning && <Badge tone={warning === "overload" ? "critical" : "warning"}>{t(`overload.level.${warning as "overload"}`)}</Badge>}
      </div>
      <DefinitionList
        className="sm:grid-cols-1"
        items={[
          { label: t("twin.layers.demand"), value: <>{chip("demand")} · {formatNumber(s.footfall.last7Total)} / 7 d</> },
          { label: t("twin.layers.stock"), value: chip("stock") },
          { label: t("twin.layers.beds"), value: chip("beds") },
          { label: t("twin.layers.doctors"), value: chip("doctors") },
          { label: t("twin.layers.diagnostics"), value: chip("diagnostics") },
          { label: t("twin.layers.alerts"), value: <>{chip("alerts")} ({s.alerts.critical} {t("severity.critical")})</> },
          { label: t("queue.waiting"), value: live ? `${live.waiting} · ${live.estWaitMinutes === null ? t("overload.noDoctor") : t("queue.estWait", { min: live.estWaitMinutes })}` : "—" },
          { label: t("common.lastUpdated"), value: formatRelative(s.facility.last_data_update, t) },
        ]}
      />
      <div className="flex flex-wrap gap-2 text-[13px]">
        <Link className="text-brand-700 hover:underline" href={`/facilities/${s.facility.id}`}>
          {t("facility.tabOverview")} →
        </Link>
        <Link className="text-brand-700 hover:underline" href={`/queue?facility=${s.facility.id}`}>
          {t("nav.queue")} →
        </Link>
        <Link className="text-brand-700 hover:underline" href={`/facilities/${s.facility.id}?tab=inventory`}>
          {t("nav.inventory")} →
        </Link>
      </div>
    </div>
  );
}
