"use client";

import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { alertTransitionAction, createManualAlertAction, runAlertEngineAction } from "@/app/actions/alerts";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormStatus, SubmitButton, inputClass, textareaClass, useActionForm, useActionRunner } from "@/components/ui/form";
import { buttonClass } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";
import { alertActionSchema, manualAlertSchema } from "@/lib/validation/schemas";

export function RunEngineButton() {
  const { t } = useI18n();
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className={buttonClass("secondary")} disabled={pending} onClick={() => run(() => runAlertEngineAction())}>
        <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} aria-hidden />
        {t("alerts.runEngine")}
      </button>
      {status && <p className={status.tone === "critical" ? "text-xs text-red-700" : "text-xs text-emerald-700"} role="status">{status.text}</p>}
    </div>
  );
}

export function ManualAlertButton({ facilities }: { facilities: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={buttonClass("primary")} onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        {t("alerts.newAlert")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("alerts.newAlert")} wide>
        {open && <ManualAlertForm facilities={facilities} onDone={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function ManualAlertForm({ facilities, onDone }: { facilities: { id: string; name: string }[]; onDone: () => void }) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status } = useActionForm(manualAlertSchema, createManualAlertAction, {
    defaultValues: { facilityId: "", severity: "warning", title: "", explanation: "", recommendedAction: "" },
    onSuccess: () => setTimeout(onDone, 600),
  });
  const e = form.formState.errors;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label={t("common.facility")} error={e.facilityId?.message} htmlFor="ma-fac">
        <select id="ma-fac" className={inputClass} aria-invalid={!!e.facilityId} {...form.register("facilityId")}>
          <option value="">—</option>
          {facilities.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("alerts.severityLabel")} htmlFor="ma-sev">
        <select id="ma-sev" className={inputClass} {...form.register("severity")}>
          {(["critical", "warning", "info"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`severity.${s}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("alerts.titleField")} error={e.title?.message} className="sm:col-span-2" htmlFor="ma-title">
        <input id="ma-title" className={inputClass} aria-invalid={!!e.title} {...form.register("title")} />
      </Field>
      <Field label={t("alerts.explanationField")} error={e.explanation?.message} className="sm:col-span-2" htmlFor="ma-exp">
        <textarea id="ma-exp" className={textareaClass} aria-invalid={!!e.explanation} {...form.register("explanation")} />
      </Field>
      <Field label={`${t("alerts.actionField")} (${t("common.optional")})`} className="sm:col-span-2" htmlFor="ma-act">
        <textarea id="ma-act" className={textareaClass} {...form.register("recommendedAction")} />
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <FormStatus status={status} />
        <div>
          <SubmitButton pending={pending}>{t("alerts.newAlert")}</SubmitButton>
        </div>
      </div>
    </form>
  );
}

export function AlertActionsPanel({
  alertId,
  status,
  admins,
  currentAssignee,
}: {
  alertId: string;
  status: string;
  admins: { id: string; name: string }[];
  currentAssignee: string | null;
}) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status: res } = useActionForm(alertActionSchema, alertTransitionAction, {
    defaultValues: {
      alertId,
      action: status === "resolved" ? "reopen" : status === "open" ? "acknowledge" : "resolve",
      assigneeId: currentAssignee ?? "",
      notes: "",
    },
  });
  const e = form.formState.errors;
  const action = form.watch("action");
  const options =
    status === "resolved"
      ? (["reopen"] as const)
      : status === "open"
        ? (["acknowledge", "assign", "resolve"] as const)
        : (["resolve", "assign"] as const);
  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      <Field label={t("common.actions")} htmlFor="aa-action">
        <select id="aa-action" className={inputClass} {...form.register("action")}>
          {options.map((o) => (
            <option key={o} value={o}>
              {t(`alerts.${o}`)}
            </option>
          ))}
        </select>
      </Field>
      {action === "assign" && (
        <Field label={t("alerts.assigned")} error={e.assigneeId?.message} htmlFor="aa-assignee">
          <select id="aa-assignee" className={inputClass} {...form.register("assigneeId")}>
            <option value="">—</option>
            {admins.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field
        label={action === "resolve" ? t("alerts.resolutionNotes") : `${t("common.notes")}${action === "reopen" ? "" : ` (${t("common.optional")})`}`}
        error={e.notes?.message}
        htmlFor="aa-notes"
      >
        <textarea id="aa-notes" className={textareaClass} aria-invalid={!!e.notes} {...form.register("notes")} />
      </Field>
      <FormStatus status={res} />
      <div>
        <SubmitButton pending={pending} variant={action === "resolve" ? "teal" : "primary"}>
          {t(`alerts.${action}`)}
        </SubmitButton>
      </div>
    </form>
  );
}
