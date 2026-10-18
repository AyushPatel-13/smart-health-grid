import type { Metadata } from "next";
import Link from "next/link";
import { AttendanceReviewButtons, ReassignmentReview, RequestReassignmentButton } from "@/components/forms/workforce-forms";
import { KpiCard, Table, Td, Th } from "@/components/ui/data";
import { Badge, Card, CardBody, CardHeader, EmptyState, Meter, Notice, PageHeader } from "@/components/ui/primitives";
import { can } from "@/lib/auth/permissions";
import { requireRole } from "@/lib/auth/user";
import { WORKFORCE_RULES as W } from "@/lib/config/rules";
import { withUser } from "@/lib/db";
import { addDays } from "@/lib/dates";
import { getSnapshots } from "@/lib/data/queries";
import { formatDateTime, formatDay, formatNumber, formatPct, formatShortDay, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";
import { computeWorkload, redeploymentRecommendations } from "@/lib/workforce/service";

export const metadata: Metadata = { title: "Doctor workforce" };

export default async function WorkforcePage() {
  await requireRole("district_admin", "read_only");
  const { t, tx, locale } = await getI18n();
  const { user, today, snaps } = await getSnapshots();
  const admin = can(user, "admin:manage");
  const fac = new Map(snaps.map((s) => [s.facility.id, s.facility]));
  const fname = (id: string) => {
    const f = fac.get(id);
    return f ? localName(f, locale) : "—";
  };

  const [loads, recs, todayRows, reassignments, review, coverage, directory] = await withUser(user.id, async (q) => [
    await computeWorkload(q, snaps, today),
    await redeploymentRecommendations(q, snaps, today),
    await q.query<{ shift_type: string; check_in_at: string | null; check_out_at: string | null; verification_status: string | null; status: string | null; late: boolean }>(
      `select s.shift_type, a.check_in_at, a.check_out_at, a.verification_status, a.status,
              coalesce(a.review_reasons ? 'late', false) as late
         from public.shifts s join public.staff st on st.id = s.staff_id and st.is_doctor
         left join public.attendance a on a.shift_id = s.id
        where s.shift_date = $1::date`,
      [today],
    ),
    await q.query<{ id: string; code: string; staff: string; from_facility_id: string; to_facility_id: string; start_date: string; end_date: string; status: string; reason: string; reviewed_at: string | null }>(
      `select r.id, r.code, st.full_name as staff, r.from_facility_id, r.to_facility_id, r.start_date, r.end_date, r.status, r.reason, r.reviewed_at
         from public.staff_reassignments r join public.staff st on st.id = r.staff_id order by r.created_at desc limit 20`,
    ),
    await q.query<{ id: string; staff: string; facility_id: string; shift_date: string; shift_type: string; review_reasons: string[]; check_in_distance_m: number | null; check_in_accuracy_m: number | null; method: string }>(
      `select a.id, st.full_name as staff, a.facility_id, s.shift_date, s.shift_type, a.review_reasons, a.check_in_distance_m, a.check_in_accuracy_m, a.method
         from public.attendance a join public.shifts s on s.id = a.shift_id join public.staff st on st.id = s.staff_id
        where a.review_status = 'needs_review' order by s.shift_date desc limit 30`,
    ),
    await q.query<{ d: string; scheduled: number; verified: number }>(
      `select s.shift_date::text as d, count(*)::int as scheduled,
              count(*) filter (where a.status = 'present' and a.verification_status = 'verified')::int as verified
         from public.shifts s join public.staff st on st.id = s.staff_id and st.is_doctor
         left join public.attendance a on a.shift_id = s.id
        where s.shift_date between $1::date - 13 and $1::date group by 1 order by 1`,
      [today],
    ),
    await q.query<{ id: string; full_name: string; designation: string; qualification: string | null; registration_number: string | null; registration_verified: boolean; facility_id: string }>(
      `select id, full_name, designation, qualification, registration_number, registration_verified, facility_id
         from public.staff where is_doctor and is_active order by facility_id, designation, full_name`,
    ),
  ]);
  const checkedIn = todayRows.filter((r) => r.check_in_at && !r.check_out_at).length;
  const verified = todayRows.filter((r) => r.verification_status === "verified" && r.status === "present").length;
  const missing = todayRows.filter((r) => !r.status).length;
  const shortfalls = loads.filter((l) => l.shortfallHours > 0);

  return (
    <>
      <PageHeader title={t("workforce.title")} subtitle={t("workforce.subtitle")} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label={t("workforce.scheduledToday")} value={todayRows.length} />
        <KpiCard label={t("workforce.checkedInNow")} value={checkedIn} tone="teal" />
        <KpiCard label={t("workforce.verifiedToday")} value={verified} tone="success" />
        <KpiCard label={t("workforce.late")} value={todayRows.filter((r) => r.late).length} tone="warning" />
        <KpiCard label={t("workforce.missing")} value={missing} tone={missing ? "warning" : "neutral"} />
        <KpiCard label={t("workforce.needsReview")} value={review.length} tone={review.length ? "warning" : "neutral"} />
      </div>

      <Card className="mt-4">
        <CardHeader title={t("workforce.understaffed")} subtitle={t("workforce.understaffedHint", { min: W.consultMinutes, util: Math.round(W.safeUtilization * 100) })} />
        <Table>
          <thead>
            <tr>
              <Th>{t("common.facility")}</Th>
              <Th>{t("workforce.date")}</Th>
              <Th align="right">{t("workforce.expected")}</Th>
              <Th align="right">{t("workforce.booked")}</Th>
              <Th align="right">{t("workforce.requiredHours")}</Th>
              <Th align="right">{t("workforce.safeHours")}</Th>
              <Th align="right">{t("workforce.shortfall")}</Th>
              <Th>{t("workforce.utilization")}</Th>
            </tr>
          </thead>
          <tbody>
            {[...loads]
              .sort((a, b) => b.shortfallHours - a.shortfallHours || (b.utilization ?? 0) - (a.utilization ?? 0))
              .slice(0, 15)
              .map((l) => (
                <tr key={`${l.facilityId}-${l.date}`} className={l.shortfallHours > 0 ? "bg-red-50/40" : ""}>
                  <Td className="text-[13px] font-medium">
                    <Link href={`/facilities/${l.facilityId}?tab=staff`} className="text-brand-700 hover:underline">
                      {fname(l.facilityId)}
                    </Link>
                  </Td>
                  <Td className="whitespace-nowrap text-[13px]">{formatShortDay(l.date, locale)}</Td>
                  <Td align="right">
                    {l.expectedPatients ?? "—"}
                    <span className="block text-[10px] text-ink-faint">{tx(`workforce.dataNote.${l.dataNote}`)}</span>
                  </Td>
                  <Td align="right" className="text-ink-muted">{l.bookedAppointments}</Td>
                  <Td align="right">{l.requiredHours ?? "—"}</Td>
                  <Td align="right">{l.safeHours}</Td>
                  <Td align="right" className={l.shortfallHours > 0 ? "font-semibold text-red-700" : ""}>{l.shortfallHours || "—"}</Td>
                  <Td className="min-w-[110px]">
                    <span className="tabular text-[12px]">{l.utilization === null ? "—" : formatPct(Math.min(l.utilization, 9.99))}</span>
                    <Meter value={l.utilization === null ? null : Math.min(1, l.utilization)} tone={(l.utilization ?? 0) > 1 ? "critical" : (l.utilization ?? 0) > 0.85 ? "warning" : "success"} label={t("workforce.utilization")} />
                  </Td>
                </tr>
              ))}
          </tbody>
        </Table>
      </Card>

      <Card className="mt-4">
        <CardHeader title={t("workforce.recommendations")} subtitle={t("workforce.recommendationsHint")} />
        <CardBody className="space-y-3">
          <Notice tone="info">{t("workforce.safeguards", { phc: W.minDoctorsPerDay.PHC, chc: W.minDoctorsPerDay.CHC })}</Notice>
          {shortfalls.length === 0 && <p className="text-sm text-ink-muted">{t("workforce.noShortfall")}</p>}
          {recs.map((r) => (
            <div key={r.key} className="rounded-lg border border-line p-3">
              <p className="text-[14px] font-medium">
                <Badge tone={r.urgency === "critical" ? "critical" : r.urgency === "high" ? "warning" : "info"}>{tx(`distribution.urgency.${r.urgency}`)}</Badge>{" "}
                {fname(r.recipient.facilityId)} · {formatDay(r.date, locale)} · {t("workforce.shortfall")}: {r.recipient.shortfallHours}
              </p>
              {r.options.length === 0 ? (
                <p className="mt-1 text-[12px] text-ink-muted">{t("distribution.noLenderBody")}</p>
              ) : (
                <ul className="mt-2 divide-y divide-line">
                  {r.options.map((o) => (
                    <li key={o.shiftId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
                      <span>
                        <span className="font-medium">{o.staffName}</span> · {fname(o.fromFacilityId)} ({t(`shiftType.${o.shiftType as "morning"}`)}, {o.hoursProvided} h)
                        <span className="block text-[12px] text-ink-muted">
                          {t("workforce.travel")}: {o.distanceKm ?? "—"} km / ~{o.travelMinutes ?? "—"} min · {t("workforce.donorAfter")}: {o.donorDoctorsAfter} ≥ {o.donorMinDoctors},{" "}
                          {formatPct(o.donorUtilizationAfter)} · {t("workforce.recipientAfter")}: {formatPct(o.recipientUtilizationAfter)}
                        </span>
                      </span>
                      {admin && (
                        <RequestReassignmentButton
                          staffId={o.staffId}
                          toFacilityId={r.recipient.facilityId}
                          date={r.date}
                          summary={{ shortfall: r.recipient.shortfallHours, donorAfter: o.donorUtilizationAfter, recipientAfter: o.recipientUtilizationAfter, km: o.distanceKm }}
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("workforce.pending")} />
          {reassignments.length === 0 ? (
            <EmptyState title={t("common.noData")} />
          ) : (
            <ul className="divide-y divide-line">
              {reassignments.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 text-[13px] sm:px-5">
                  <div>
                    <span className="font-mono text-[12px]">{r.code}</span> <Badge tone={r.status === "approved" ? "success" : r.status === "pending" ? "warning" : "neutral"}>{tx(`workforce.status.${r.status}`)}</Badge>
                    <p className="font-medium">
                      {r.staff}: {fname(r.from_facility_id)} → {fname(r.to_facility_id)}
                    </p>
                    <p className="text-[12px] text-ink-muted">
                      {formatDay(r.start_date, locale)} – {formatDay(r.end_date, locale)} · {r.reason}
                    </p>
                  </div>
                  {admin && r.status === "pending" && <ReassignmentReview id={r.id} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title={t("workforce.reviewQueue")} subtitle={t("workforce.reviewHint")} />
          {review.length === 0 ? (
            <EmptyState title={t("common.noData")} />
          ) : (
            <ul className="divide-y divide-line">
              {review.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 text-[13px] sm:px-5">
                  <div>
                    <p className="font-medium">
                      {r.staff} · {fname(r.facility_id)}
                    </p>
                    <p className="text-[12px] text-ink-muted">
                      {formatDay(r.shift_date, locale)} · {t(`shiftType.${r.shift_type as "morning"}`)} · {r.check_in_distance_m ?? "—"} m ± {r.check_in_accuracy_m ?? "—"} m
                      {r.method === "mobile_geofence_simulated" && " · SIMULATED"}
                    </p>
                    <p className="text-[12px] text-amber-800">{(r.review_reasons ?? []).map((x) => tx(`workforce.reasons.${x}`)).join(", ")}</p>
                  </div>
                  {admin && <AttendanceReviewButtons attendanceId={r.id} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title={t("workforce.coverage")} />
          <CardBody className="space-y-1.5">
            {coverage.map((c) => (
              <div key={c.d} className="grid grid-cols-[70px_1fr_70px] items-center gap-2 text-[12px]">
                <span>{formatShortDay(c.d, locale)}</span>
                <Meter value={c.scheduled ? c.verified / c.scheduled : null} tone={c.scheduled && c.verified / c.scheduled < 0.7 ? "warning" : "success"} label={t("workforce.coverage")} />
                <span className="tabular text-right">
                  {c.verified}/{c.scheduled}
                </span>
              </div>
            ))}
            <p className="pt-1 text-[11px] text-ink-faint">
              {t("workforce.verified")} / {t("workforce.scheduled")}
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title={t("workforce.directory")} />
          <div className="max-h-[420px] overflow-y-auto">
            <Table>
              <thead>
                <tr>
                  <Th>{t("common.name")}</Th>
                  <Th>{t("common.facility")}</Th>
                  <Th>{t("workforce.qualification")}</Th>
                  <Th>{t("workforce.registration")}</Th>
                </tr>
              </thead>
              <tbody>
                {directory.map((d) => (
                  <tr key={d.id}>
                    <Td className="text-[13px]">
                      {d.full_name}
                      <span className="block text-[11px] text-ink-muted">{t(`designation.${d.designation as "other"}`)}</span>
                    </Td>
                    <Td className="text-[12px]">{fname(d.facility_id)}</Td>
                    <Td className="text-[12px]">{d.qualification ?? "—"}</Td>
                    <Td className="text-[12px]">
                      <span className="font-mono">{d.registration_number ?? "—"}</span>
                      {d.registration_verified && <Badge tone="success" className="ml-1">{t("workforce.regVerified")}</Badge>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      </div>
      <p className="mt-3 text-[11px] text-ink-faint">
        {formatDateTime(new Date().toISOString(), locale)} · {formatNumber(snaps.length)} {t("nav.facilities")} · {addDays(today, W.horizonDays - 1)}
      </p>
    </>
  );
}
