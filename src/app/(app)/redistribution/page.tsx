import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import { CreateFromRecommendationButton } from "@/components/forms/transfer-forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { stockRiskTone } from "@/components/ui/tones";
import { can } from "@/lib/auth/permissions";
import { requireRole } from "@/lib/auth/user";
import { REDISTRIBUTION_RULES as R } from "@/lib/config/rules";
import { getRecommendations, getSnapshots } from "@/lib/data/queries";
import { formatDay, formatNumber, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Redistribution" };

export default async function RedistributionPage() {
  const user = await requireRole("district_admin", "read_only");
  const { t, tx, locale } = await getI18n();
  const recs = await getRecommendations();
  const { snaps } = await getSnapshots();
  const fac = new Map(snaps.map((s) => [s.facility.id, s.facility]));
  const medName = new Map(snaps.flatMap((s) => s.medicines.map((m) => [m.medicineId, m] as const)));
  const fname = (id: string) => {
    const f = fac.get(id);
    return f ? localName(f, locale) : id;
  };

  return (
    <>
      <PageHeader title={t("redistribution.title")} subtitle={t("redistribution.subtitle")} />
      <Card className="mb-4">
        <CardHeader title={t("redistribution.guarantees")} />
        <CardBody>
          <ul className="grid gap-2 text-[13px] sm:grid-cols-2">
            {[
              t("redistribution.guarantee1", { shelf: R.minShelfDays }),
              t("redistribution.guarantee2", { buffer: R.donorReserveBufferDays }),
              t("redistribution.guarantee3"),
              t("redistribution.guarantee4"),
            ].map((g) => (
              <li key={g} className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-teal-600" aria-hidden />
                {g}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      {recs.length === 0 ? (
        <Card>
          <EmptyState title={t("redistribution.empty")} />
        </Card>
      ) : (
        <div className="space-y-4">
          {recs.map((r) => {
            const med = medName.get(r.medicineId);
            const unit = t(`units.${r.unit as "tablet"}`);
            return (
              <Card key={r.key}>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="text-[15px] font-semibold">
                      {formatNumber(r.quantity)} {unit} · {med ? localName(med, locale) : r.medicineName}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[13px] text-ink-muted">
                      <Link className="text-brand-700 hover:underline" href={`/facilities/${r.donor.facilityId}?tab=inventory&med=${r.medicineId}`}>
                        {fname(r.donor.facilityId)}
                      </Link>
                      <ArrowRight className="size-3.5" aria-hidden />
                      <Link className="text-brand-700 hover:underline" href={`/facilities/${r.recipient.facilityId}?tab=inventory&med=${r.medicineId}`}>
                        {fname(r.recipient.facilityId)}
                      </Link>
                      {r.distanceKm !== null && <span>· {t("redistribution.transitValue", { km: r.distanceKm, hours: r.transitHours })}</span>}
                    </p>
                  </div>
                  {r.existingRequest ? (
                    <Link href="/transfers" className="text-[13px]">
                      <Badge tone="info">
                        {t("redistribution.requested")}: {r.existingRequest}
                      </Badge>
                    </Link>
                  ) : (
                    can(user, "transfers:review") && (
                      <CreateFromRecommendationButton
                        recommendationKey={r.key}
                        medicineId={r.medicineId}
                        fromFacilityId={r.donor.facilityId}
                        toFacilityId={r.recipient.facilityId}
                        quantity={r.quantity}
                        justification={`Recommended: ${r.recipient.facilityName} projected shortage of ${r.medicineName}; ${r.donor.facilityName} holds surplus.`}
                      />
                    )
                  )}
                </div>
                <div className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-3">
                  <section>
                    <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
                      {t("redistribution.recipient")} · {t("redistribution.projectedShortage")}
                    </h3>
                    <dl className="mt-2 space-y-1 text-[13px]">
                      <Row label={t("common.status")} value={<Badge tone={stockRiskTone[r.recipient.risk]}>{t(`stockRisk.${r.recipient.risk}`)}</Badge>} />
                      <Row label={t("redistribution.usable")} value={`${formatNumber(r.recipient.usable)} ${unit}`} />
                      <Row label={t("redistribution.demand")} value={`${formatNumber(r.recipient.dailyDemand)}${t("common.perDay")}`} />
                      <Row label={t("inventory.colDays")} value={formatNumber(r.recipient.daysOfStockBefore)} />
                      <Row label={t("redistribution.need")} value={<strong>{formatNumber(r.recipient.need)}</strong>} />
                    </dl>
                    <p className="mt-2 font-mono text-[11px] text-ink-faint">{t("redistribution.needCalc", { window: r.recipient.coverWindowDays })}</p>
                  </section>
                  <section>
                    <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
                      {t("redistribution.donor")} · {t("redistribution.donorSurplus")}
                    </h3>
                    <dl className="mt-2 space-y-1 text-[13px]">
                      <Row label={t("redistribution.usable")} value={`${formatNumber(r.donor.usable)} ${unit}`} />
                      <Row label={t("redistribution.demand")} value={`${formatNumber(r.donor.dailyDemand)}${t("common.perDay")}`} />
                      <Row label={t("redistribution.reserve")} value={formatNumber(r.donor.reserve)} />
                      <Row label={t("redistribution.donorSurplus")} value={<strong>{formatNumber(r.donor.surplus)}</strong>} />
                      <Row
                        label={t("redistribution.remainingAfter")}
                        value={`${formatNumber(r.donor.remainingAfter)} (≥ ${t("redistribution.safety")} ${formatNumber(r.donor.safetyStock)})`}
                      />
                    </dl>
                    <p className="mt-2 font-mono text-[11px] text-ink-faint">
                      {t("redistribution.donorCalc", { shelf: R.minShelfDays, buffer: R.donorReserveBufferDays })}
                    </p>
                  </section>
                  <section>
                    <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">{t("redistribution.batches")}</h3>
                    <ul className="mt-2 space-y-1 text-[13px]">
                      {r.batches.map((b) => (
                        <li key={b.batchNumber} className="flex justify-between gap-2">
                          <span className="font-mono text-[12px]">{b.batchNumber}</span>
                          <span className="tabular">
                            {formatNumber(b.quantity)} · {t("inventory.expiry")} {formatDay(b.expiryDate, locale)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-3 rounded-lg bg-teal-50 px-3 py-2 text-[13px] text-teal-700">
                      <span className="font-medium">{t("redistribution.effect")}: </span>
                      {t("redistribution.effectValue", { before: r.recipient.daysOfStockBefore, after: r.recipient.daysOfStockAfter })}
                    </p>
                    <h3 className="mt-3 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">{t("redistribution.reasons")}</h3>
                    <ul className="mt-1 space-y-0.5 text-[12px] text-ink-muted">
                      {r.reasons.map((x, i) => (
                        <li key={i}>• {tx(x.key, x.params)}</li>
                      ))}
                    </ul>
                  </section>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function Row({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular text-right">{value}</dd>
    </div>
  );
}
