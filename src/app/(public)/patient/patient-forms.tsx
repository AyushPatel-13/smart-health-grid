"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { patientCancelAction, patientLoginAction, patientLogoutAction, patientNewRequestAction } from "@/app/actions/patients";
import { Field, inputClass } from "@/components/ui/form";
import { Notice, buttonClass } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";

function useResultText() {
  const { tx } = useI18n();
  return (error: string) => tx(error.includes(".") ? error : `errors.${error}`);
}

export function PatientLoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const errText = useResultText();
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const r = await patientLoginAction({ patientCode: code, pin });
          if (r.ok) router.refresh();
          else setError(errText(r.error));
        });
      }}
    >
      <Field label={t("patient.patientId")} htmlFor="p-code">
        <input id="p-code" className={`${inputClass} font-mono uppercase`} value={code} onChange={(e) => setCode(e.target.value)} placeholder="SHG-XXXXXXXX" autoComplete="username" />
      </Field>
      <Field label={t("patient.pin")} htmlFor="p-pin">
        <input id="p-pin" type="password" inputMode="numeric" maxLength={6} className={`${inputClass} font-mono`} value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="current-password" />
      </Field>
      {error && <Notice tone="critical">{error}</Notice>}
      <button type="submit" disabled={pending} className={buttonClass("primary")}>
        {pending ? t("common.loading") : t("patient.signIn")}
      </button>
    </form>
  );
}

export function PatientLogoutButton() {
  const { t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className={buttonClass("secondary")} disabled={pending} onClick={() => start(async () => { await patientLogoutAction(); router.refresh(); })}>
      {t("patient.signOut")}
    </button>
  );
}

export function CancelAppointmentForm({ appointmentId }: { appointmentId: string }) {
  const { t, tx } = useI18n();
  const router = useRouter();
  const errText = useResultText();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  if (!open) {
    return (
      <button type="button" className={`${buttonClass("secondary", "sm")} mt-2`} onClick={() => setOpen(true)}>
        {t("patient.cancel")}
      </button>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await patientCancelAction({ appointmentId, reason });
          setMsg(r.ok ? { ok: true, text: tx(r.message ?? "common.saved") } : { ok: false, text: errText(r.error) });
          if (r.ok) router.refresh();
        });
      }}
    >
      <label className="flex-1 text-[12px]">
        {t("patient.cancelReason")}
        <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button type="submit" className={buttonClass("danger", "sm")} disabled={pending}>
        {t("patient.cancel")}
      </button>
      {msg && <p className={msg.ok ? "w-full text-[12px] text-emerald-800" : "w-full text-[12px] text-red-700"}>{msg.text}</p>}
    </form>
  );
}

export function AlternativeButton({ serviceId, date, time, facilityId }: { serviceId: string; date: string; time: string; facilityId: string }) {
  const { t, tx } = useI18n();
  const router = useRouter();
  const errText = useResultText();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [key] = useState(() => crypto.randomUUID());
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending || msg?.ok}
        className={buttonClass("teal", "sm")}
        onClick={() =>
          start(async () => {
            const r = await patientNewRequestAction({ serviceId, date, time, preferredFacilityId: facilityId, idempotencyKey: key });
            setMsg(r.ok ? { ok: true, text: tx("patient.alternativeRequested") } : { ok: false, text: errText(r.error) });
            if (r.ok) router.refresh();
          })
        }
      >
        {t("patient.requestAlternative")}
      </button>
      {msg && <p className={msg.ok ? "text-[11px] text-emerald-800" : "text-[11px] text-red-700"}>{msg.text}</p>}
    </div>
  );
}
