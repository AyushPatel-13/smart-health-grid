import { ArrowRight } from "lucide-react";
import { CreateFromRecommendationButton } from "@/components/forms/transfer-forms";
import { Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, EmptyState } from "@/components/ui/primitives";
import { expiryOptimizer } from "@/lib/analytics/expiry";
import { toStockPositions, type FacilitySnapshot } from "@/lib/data/snapshot";
import { formatDay, formatNumber, type Locale, type TFunction, type TxFunction } from "@/lib/i18n";
import { REDISTRIBUTION_RULES as R, STOCK_RULES } from "@/lib/config/rules";

/** Near-expiry batches at risk of wastage, and safe redistribution proposals. */
export function ExpiryOptimizerCard({
  snaps,
  committed,
  today,
  canRequest,
  existing,
  t,
  tx,
  locale,
}: {
  snaps: FacilitySnapshot[];
  committed: Map<string, number>;
  today: string;
  canRequest: boolean;
  existing: Set<string>;
  t: TFunction;
  tx: TxFunction;
  locale: Locale;
}) {
  const { risks, recs } = expiryOptimizer(toStockPositions(snaps), committed, today);
  const wasted = risks.reduce((a, r) => a + r.atRisk, 0);
  return (
    <Card>
      <CardHeader title={t("expiry.title")} subtitle={t("expiry.subtitle", { days: STOCK_RULES.nearExpiryDays, shelf: R.minShelfDays })} />
      <CardBody className="space-y-4">
        {risks.length === 0 ? (
          <EmptyState title={t("expiry.none")} />
        ) : (
          <>
            <p className="text-[13px] text-ink-muted">{t("expiry.summary", { batches: risks.length, qty: wasted })}</p>
            <Table>
              <thead>
                <tr>
                  <Th>{t("common.facility")}</Th>
                  <Th>{t("inventory.batchNumber")}</Th>
                  <Th>{t("inventory.expiry")}</Th>
                  <Th align="right">{t("expiry.usedLocally")}</Th>
                  <Th align="right">{t("expiry.atRisk")}</Th>
                  <Th>{t("common.status")}</Th>
                </tr>
              </thead>
              <tbody>
                {risks.map((r) => (
                  <tr key={`${r.facilityId}-${r.batchNumber}`}>
                    <Td className="text-[13px]">
                      {r.facilityName}
                      <span className="block text-[11px] text-ink-muted">{r.medicineName}</span>
                    </Td>
                    <Td className="font-mono text-[12px]">{r.batchNumber}</Td>
                    <Td className="whitespace-nowrap text-[13px]">
                      {formatDay(r.expiryDate, locale)}
                      <span className="block text-[11px] text-ink-muted">{t("inventory.daysValue", { n: r.daysToExpiry })}</span>
                    </Td>
                    <Td align="right">
                      {formatNumber(r.usedLocally)}/{formatNumber(r.quantity)}
                    </Td>
                    <Td align="right" className="font-semibold text-amber-800">
                      {formatNumber(r.atRisk)}
                    </Td>
                    <Td>
                      {r.movable ? <Badge tone="teal">{t("expiry.movable")}</Badge> : <Badge tone="warning">{t("expiry.tooClose")}</Badge>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </>
        )}
        {recs.map((r) => (
          <div key={r.key} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line p-3 text-[13px]">
            <div>
              <p className="flex flex-wrap items-center gap-1 font-medium">
                {formatNumber(r.quantity)} · {r.risk.medicineName} ({r.risk.batchNumber}) · {r.risk.facilityName} <ArrowRight className="size-3.5" aria-hidden /> {r.recipientName}
              </p>
              <ul className="mt-1 space-y-0.5 text-[12px] text-ink-muted">
                {r.reasons.map((x, i) => (
                  <li key={i}>• {tx(x.key, x.params)}</li>
                ))}
                {r.distanceKm !== null && <li>• {t("redistribution.transitValue", { km: r.distanceKm, hours: r.transitHours })} ({t("distribution.estimateLabel")})</li>}
              </ul>
            </div>
            {existing.has(`${r.risk.medicineId}:${r.risk.facilityId}:${r.recipientId}`) ? (
              <Badge tone="info">{t("redistribution.requested")}</Badge>
            ) : (
              canRequest && (
                <CreateFromRecommendationButton
                  source="expiry"
                  label={t("expiry.request")}
                  recommendationKey={r.key}
                  medicineId={r.risk.medicineId}
                  fromFacilityId={r.risk.facilityId}
                  toFacilityId={r.recipientId}
                  quantity={r.quantity}
                  justification={`Near-expiry redistribution: batch ${r.risk.batchNumber} (exp ${r.risk.expiryDate}) at risk of wastage.`}
                />
              )
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
