import type { Metadata } from "next";
import Link from "next/link";
import { KpiCard, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import { attendanceTone } from "@/components/ui/tones";
import { getSnapshots } from "@/lib/data/queries";
import { formatNumber, formatPct, formatShortDay, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Staff attendance" };

const CLASSES = ["present", "unverified", "approved_leave", "absent_verified", "incomplete", "pending"] as const;

export default async function AttendancePage() {
  const { t, tx, locale } = await getI18n();
  const { snaps } = await getSnapshots();
  const totals = Object.fromEntries(CLASSES.map((c) => [c, snaps.reduce((a, s) => a + s.attendance.counts[c], 0)])) as Record<(typeof CLASSES)[number], number>;
  const review = snaps.filter((s) => s.attendance.needsReview);
  const rows = [...snaps].sort(
    (a, b) => Number(b.attendance.needsReview) - Number(a.attendance.needsReview) || (a.attendance.doctorCoverage ?? 1) - (b.attendance.doctorCoverage ?? 1),
  );
  return (
    <>
      <PageHeader title={t("attendance.title")} subtitle={t("attendance.subtitle")} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {CLASSES.map((c) => (
          <KpiCard key={c} label={t(`attendanceClass.${c}`)} value={formatNumber(totals[c])} tone={attendanceTone[c] === "critical" ? "critical" : attendanceTone[c] === "warning" ? "warning" : "neutral"} />
        ))}
      </div>
      {review.length > 0 && (
        <Notice tone="warning" className="mt-4">
          {t("attendance.needsReview")}: {review.map((s) => localName(s.facility, locale)).join(", ")}
        </Notice>
      )}
      <Card className="mt-4">
        <CardHeader title={t("attendance.summary")} subtitle={t("attendance.window")} />
        {rows.length === 0 ? (
          <EmptyState title={t("common.noData")} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>{t("common.facility")}</Th>
                <Th align="right">{t("attendance.coverage")}</Th>
                {CLASSES.map((c) => (
                  <Th key={c} align="right">
                    {t(`attendanceClass.${c}`)}
                  </Th>
                ))}
                <Th>{t("attendance.daysWithoutDoctor")}</Th>
                <Th>{t("common.status")}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const a = s.attendance;
                return (
                  <tr key={s.facility.id}>
                    <Td>
                      <Link href={`/facilities/${s.facility.id}?tab=staff`} className="font-medium text-brand-700 hover:underline">
                        {localName(s.facility, locale)}
                      </Link>
                    </Td>
                    <Td align="right">
                      <Badge tone={a.doctorCoverage !== null && a.doctorCoverage < 0.7 ? "critical" : a.doctorCoverage !== null && a.doctorCoverage < 0.85 ? "warning" : "success"}>
                        {formatPct(a.doctorCoverage)}
                      </Badge>
                    </Td>
                    {CLASSES.map((c) => (
                      <Td key={c} align="right">
                        {a.counts[c]}
                      </Td>
                    ))}
                    <Td className="text-[12px]">{a.daysWithoutDoctor.length ? a.daysWithoutDoctor.map((d) => formatShortDay(d, locale)).join(", ") : "—"}</Td>
                    <Td className="min-w-[200px]">
                      {a.needsReview ? (
                        <>
                          <Badge tone="warning">{t("attendance.needsReview")}</Badge>
                          <ul className="mt-1 text-[11px] text-ink-muted">
                            {a.reviewReasons.map((r, i) => (
                              <li key={i}>• {tx(r.key, r.params)}</li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <Badge tone="success">{t("facilities.staffingOk")}</Badge>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
