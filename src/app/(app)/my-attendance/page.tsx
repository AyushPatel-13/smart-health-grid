import type { Metadata } from "next";
import { MobileAttendance } from "@/components/forms/workforce-forms";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import { requireUser } from "@/lib/auth/user";
import { withUser } from "@/lib/db";
import { isDemoMode } from "@/lib/env";
import { todayIST } from "@/lib/dates";
import { formatDateTime, formatDay, localName } from "@/lib/i18n";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "My attendance" };

export default async function MyAttendancePage() {
  const user = await requireUser();
  const { t, tx, locale } = await getI18n();
  const [staff, shifts] = await withUser(user.id, async (q) => [
    (await q.query<{ id: string; full_name: string; designation: string; facility: string; facility_hi: string | null; radius: number }>(
      `select st.id, st.full_name, st.designation, h.name as facility, h.name_hi as facility_hi, h.geofence_radius_m as radius
         from public.staff st join public.health_centres h on h.id = st.facility_id where st.profile_id = $1`,
      [user.id],
    ))[0],
    await q.query<{ id: string; shift_date: string; shift_type: string; facility: string; status: string | null; verification_status: string | null;
      check_in_at: string | null; check_out_at: string | null; review_status: string | null; review_reasons: string[] | null; duty_minutes: number | null; method: string | null }>(
      `select s.id, s.shift_date, s.shift_type, h.name as facility, a.status, a.verification_status, a.check_in_at, a.check_out_at,
              a.review_status, a.review_reasons, a.duty_minutes, a.method
         from public.shifts s join public.staff st on st.id = s.staff_id and st.profile_id = $1
         join public.health_centres h on h.id = s.facility_id
         left join public.attendance a on a.shift_id = s.id
        where s.shift_date between current_date - 7 and current_date order by s.shift_date desc, s.shift_type`,
      [user.id],
    ),
  ]);
  if (!staff) {
    return (
      <>
        <PageHeader title={t("myAttendance.title")} />
        <Notice tone="info">{t("myAttendance.noLink")}</Notice>
      </>
    );
  }
  const todayStr = todayIST();
  const today = shifts.filter((s) => s.shift_date === todayStr);
  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title={t("myAttendance.title")} subtitle={t("myAttendance.subtitle")} />
      <Notice tone="info" className="mb-4">
        {t("myAttendance.privacy")}
      </Notice>
      <Card>
        <CardHeader title={t("myAttendance.todayShifts")} subtitle={`${staff.full_name} · ${localName({ name: staff.facility, name_hi: staff.facility_hi }, locale)} · ${t("myAttendance.geofence", { m: staff.radius })}`} />
        <CardBody className="space-y-5">
          {today.length === 0 && <EmptyState title={t("myAttendance.noShift")} />}
          {today.map((s) => (
            <div key={s.id} className="space-y-2">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {t(`shiftType.${s.shift_type as "morning"}`)} · {s.facility}
                {s.check_in_at && <Badge tone={s.verification_status === "verified" ? "success" : "warning"}>{t("myAttendance.checkedInAt")} {formatDateTime(s.check_in_at, locale)}</Badge>}
                {s.check_out_at && <Badge tone="info">{t("myAttendance.checkedOutAt")} {formatDateTime(s.check_out_at, locale)}</Badge>}
              </p>
              <MobileAttendance shiftId={s.id} canCheckIn={!s.check_in_at} canCheckOut={!!s.check_in_at && !s.check_out_at} demo={isDemoMode()} />
            </div>
          ))}
        </CardBody>
      </Card>
      <Card className="mt-4">
        <CardHeader title={t("myAttendance.history")} />
        <ul className="divide-y divide-line">
          {shifts.map((s) => (
            <li key={s.id} className="px-4 py-2.5 text-[13px] sm:px-5">
              <p className="font-medium">
                {formatDay(s.shift_date, locale)} · {t(`shiftType.${s.shift_type as "morning"}`)}
              </p>
              <p className="text-[12px] text-ink-muted">
                {s.status ? t(`attendanceClass.${s.verification_status === "verified" ? (s.status === "present" ? "present" : s.status === "approved_leave" ? "approved_leave" : "absent_verified") : "unverified"}`) : t("attendanceClass.pending")}
                {s.duty_minutes != null && ` · ${t("myAttendance.duty")}: ${Math.floor(s.duty_minutes / 60)}h ${s.duty_minutes % 60}m`}
                {s.method === "mobile_geofence_simulated" && " · SIMULATED"}
              </p>
              {s.review_status === "needs_review" && (
                <p className="text-[12px] text-amber-800">
                  {t("workforce.needsReview")}: {(s.review_reasons ?? []).map((r) => tx(`workforce.reasons.${r}`)).join(", ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
