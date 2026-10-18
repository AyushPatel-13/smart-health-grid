"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { checkInAction, closeWindowNowAction, runDueAllocationsAction, staffCancelAppointmentAction, visitStatusAction } from "@/app/actions/patients";
import { useActionRunner } from "@/components/ui/form";
import { buttonClass, cn } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";
import { inputClass } from "@/components/ui/form";

function Status({ status }: { status: { tone: string; text: string } | null }) {
  if (!status) return null;
  return <p role="status" className={status.tone === "critical" ? "text-[11px] text-red-700" : "text-[11px] text-emerald-700"}>{status.text}</p>;
}

/** Refresh server data periodically (queue screens). Pauses when the tab is hidden. */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}

export function CheckInButton({ facilityId, patientCode, appointmentId }: { facilityId: string; patientCode: string; appointmentId: string }) {
  const { t } = useI18n();
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-0.5">
      <button type="button" disabled={pending} className={buttonClass("primary", "sm")} onClick={() => run(() => checkInAction({ facilityId, patientCode, appointmentId }))}>
        {t("queue.checkIn")}
      </button>
      <Status status={status} />
    </div>
  );
}

export function WalkInForm({ facilityId }: { facilityId: string }) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const { run, pending, status } = useActionRunner();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => checkInAction({ facilityId, patientCode: code, appointmentId: null }), (r) => r.ok && setCode(""));
      }}
    >
      <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[13px] font-medium">
        {t("queue.patientCode")}
        <input className={`${inputClass} font-mono uppercase`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="SHG-XXXXXXXX" />
      </label>
      <button type="submit" disabled={pending || code.length < 6} className={buttonClass("primary")}>
        {t("queue.checkIn")}
      </button>
      <div className="w-full">
        <Status status={status} />
      </div>
    </form>
  );
}

export function VisitActions({ visitId, status }: { visitId: string; status: string }) {
  const { t } = useI18n();
  const { run, pending, status: res } = useActionRunner();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  if (status !== "waiting" && status !== "in_consultation") return null;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1">
        {status === "waiting" && (
          <button type="button" disabled={pending} className={cn(buttonClass("primary", "sm"), "h-7 px-2 text-xs")} onClick={() => run(() => visitStatusAction({ visitId, status: "in_consultation" }))}>
            {t("queue.start")}
          </button>
        )}
        <button type="button" disabled={pending} className={cn(buttonClass("teal", "sm"), "h-7 px-2 text-xs")} onClick={() => run(() => visitStatusAction({ visitId, status: "completed" }))}>
          {t("queue.complete")}
        </button>
        <button type="button" disabled={pending} className={cn(buttonClass("secondary", "sm"), "h-7 px-2 text-xs")} onClick={() => run(() => visitStatusAction({ visitId, status: "left_without_care" }))}>
          {t("queue.leftWithoutCare")}
        </button>
        <button type="button" className={cn(buttonClass("ghost", "sm"), "h-7 px-2 text-xs")} onClick={() => setCancelling((v) => !v)}>
          {t("queue.cancelVisit")}
        </button>
      </div>
      {cancelling && (
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => visitStatusAction({ visitId, status: "cancelled", reason }));
          }}
        >
          <input className={`${inputClass} h-7 text-xs`} placeholder={t("queue.cancelReason")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="submit" className={cn(buttonClass("danger", "sm"), "h-7 px-2 text-xs")} disabled={pending}>
            {t("common.confirm")}
          </button>
        </form>
      )}
      <Status status={res} />
    </div>
  );
}

export function StaffCancelAppointment({ appointmentId }: { appointmentId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-1">
      {!open ? (
        <button type="button" className={cn(buttonClass("ghost", "sm"), "h-7 px-2 text-xs")} onClick={() => setOpen(true)}>
          {t("patient.cancel")}
        </button>
      ) : (
        <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); run(() => staffCancelAppointmentAction({ appointmentId, reason })); }}>
          <input className={`${inputClass} h-7 text-xs`} placeholder={t("patient.cancelReason")} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="submit" className={cn(buttonClass("danger", "sm"), "h-7 px-2 text-xs")} disabled={pending}>
            {t("common.confirm")}
          </button>
        </form>
      )}
      <Status status={status} />
    </div>
  );
}

export function CloseWindowButton({ windowId }: { windowId: string }) {
  const { t } = useI18n();
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" disabled={pending} className={buttonClass("teal")} onClick={() => run(() => closeWindowNowAction({ windowId }))}>
        {pending ? t("common.submitting") : t("allocation.closeNow")}
      </button>
      <Status status={status} />
    </div>
  );
}

export function RunDueButton({ label }: { label?: string }) {
  const { t } = useI18n();
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" disabled={pending} className={buttonClass("secondary")} onClick={() => run(() => runDueAllocationsAction())}>
        {pending ? t("common.submitting") : label ?? t("allocation.runDue")}
      </button>
      <Status status={status} />
    </div>
  );
}
