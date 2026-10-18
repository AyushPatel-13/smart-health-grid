"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { mobileAttendanceAction, requestReassignmentAction, reviewAttendanceAction, reviewReassignmentAction } from "@/app/actions/workforce";
import { Field, inputClass } from "@/components/ui/form";
import { Notice, buttonClass, cn } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";
import { ActionDialogButton } from "./action-dialog";

export function RequestReassignmentButton({ staffId, toFacilityId, date, summary }: { staffId: string; toFacilityId: string; date: string; summary: Record<string, unknown> }) {
  const { t } = useI18n();
  return (
    <ActionDialogButton
      label={t("workforce.requestReassign")}
      title={t("workforce.requestReassign")}
      variant="teal"
      fields={[{ name: "reason", label: t("workforce.reassignReason"), type: "textarea", defaultValue: "Projected demand exceeds safe doctor capacity" }]}
      action={(v) => requestReassignmentAction({ staffId, toFacilityId, date, reason: v.reason, recommendation: summary })}
    />
  );
}

export function ReassignmentReview({ id }: { id: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <ActionDialogButton
        label={t("workforce.approve")}
        title={t("workforce.approve")}
        variant="teal"
        fields={[{ name: "notes", label: `${t("common.notes")} (${t("common.optional")})`, type: "textarea" }]}
        action={(v) => reviewReassignmentAction({ id, approve: true, notes: v.notes })}
      />
      <ActionDialogButton
        label={t("workforce.reject")}
        title={t("workforce.reject")}
        variant="secondary"
        fields={[{ name: "notes", label: t("common.reason"), type: "textarea" }]}
        action={(v) => reviewReassignmentAction({ id, approve: false, notes: v.notes })}
      />
    </div>
  );
}

export function AttendanceReviewButtons({ attendanceId }: { attendanceId: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap justify-end gap-1">
      <ActionDialogButton
        label={t("workforce.verify")}
        title={t("workforce.verify")}
        variant="teal"
        fields={[{ name: "notes", label: t("workforce.reviewNotes"), type: "textarea" }]}
        action={(v) => reviewAttendanceAction({ attendanceId, verify: true, notes: v.notes })}
      />
      <ActionDialogButton
        label={t("workforce.keepUnverified")}
        title={t("workforce.keepUnverified")}
        variant="secondary"
        fields={[{ name: "notes", label: t("workforce.reviewNotes"), type: "textarea" }]}
        action={(v) => reviewAttendanceAction({ attendanceId, verify: false, notes: v.notes })}
      />
    </div>
  );
}

/** Mobile check-in/out with location consent + password step-up. */
export function MobileAttendance({ shiftId, canCheckIn, canCheckOut, demo }: { shiftId: string; canCheckIn: boolean; canCheckOut: boolean; demo: boolean }) {
  const { t, tx } = useI18n();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [simulate, setSimulate] = useState<"" | "at" | "away">(demo ? "at" : "");
  const [msg, setMsg] = useState<{ tone: "success" | "critical" | "warning"; text: string; reasons?: string[] } | null>(null);
  const [pending, start] = useTransition();
  const [nonce, setNonce] = useState(() => crypto.randomUUID());

  const send = (event: "check_in" | "check_out", pos: GeolocationPosition | null) =>
    start(async () => {
      const res = await mobileAttendanceAction({
        shiftId,
        event,
        lat: pos?.coords.latitude ?? null,
        lon: pos?.coords.longitude ?? null,
        accuracy: pos?.coords.accuracy ?? null,
        positionTime: pos?.timestamp ?? null,
        nonce,
        password,
        simulate: simulate || null,
      });
      if (res.ok) {
        const data = res.data as { result: string; reasons: string[] };
        setMsg({ tone: data.result === "accepted" ? "success" : "warning", text: tx(`myAttendance.result.${data.result}`), reasons: data.reasons });
        setNonce(crypto.randomUUID()); // new attempt → new nonce; a network retry reuses the old one
        setPassword("");
        router.refresh();
      } else {
        setMsg({ tone: "critical", text: tx(res.error.includes(".") ? res.error : `errors.${res.error}`) });
      }
    });

  const go = (event: "check_in" | "check_out") => {
    setMsg(null);
    if (simulate || !("geolocation" in navigator)) return send(event, null);
    setMsg({ tone: "warning", text: t("myAttendance.locating") });
    navigator.geolocation.getCurrentPosition(
      (pos) => send(event, pos),
      () => {
        setMsg({ tone: "warning", text: t("myAttendance.gpsFailed") });
        send(event, null);
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };

  return (
    <div className="space-y-3">
      <Field label={t("myAttendance.identity")} hint={t("myAttendance.password")} htmlFor={`pw-${shiftId}`}>
        <input id={`pw-${shiftId}`} type="password" autoComplete="current-password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {demo && (
        <fieldset className="rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2 text-[12px]">
          <legend className="px-1 font-medium text-amber-900">{t("myAttendance.simulate")}</legend>
          {(["at", "away", ""] as const).map((v) => (
            <label key={v || "off"} className="mr-3 inline-flex items-center gap-1">
              <input type="radio" name={`sim-${shiftId}`} checked={simulate === v} onChange={() => setSimulate(v)} />
              {v === "at" ? t("myAttendance.simulateAt") : v === "away" ? t("myAttendance.simulateAway") : t("myAttendance.simulateOff")}
            </label>
          ))}
          <p className="mt-1 text-amber-800">{t("myAttendance.simulatedNote")}</p>
        </fieldset>
      )}
      <div className="flex gap-2">
        <button type="button" disabled={!canCheckIn || pending || !password} onClick={() => go("check_in")} className={cn(buttonClass("teal"), "h-11 flex-1 text-base")}>
          {t("myAttendance.checkIn")}
        </button>
        <button type="button" disabled={!canCheckOut || pending || !password} onClick={() => go("check_out")} className={cn(buttonClass("primary"), "h-11 flex-1 text-base")}>
          {t("myAttendance.checkOut")}
        </button>
      </div>
      {msg && (
        <Notice tone={msg.tone}>
          {msg.text}
          {msg.reasons && msg.reasons.length > 0 && (
            <ul className="mt-1">
              {msg.reasons.map((r) => (
                <li key={r}>• {tx(`workforce.reasons.${r}`)}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}
    </div>
  );
}
