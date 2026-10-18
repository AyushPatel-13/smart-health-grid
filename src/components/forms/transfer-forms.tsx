"use client";

import { useState } from "react";
import { ArrowRightLeft, Plus } from "lucide-react";
import {
  cancelTransferAction,
  completeTransferAction,
  createTransferRequestAction,
  reviewTransferAction,
} from "@/app/actions/transfers";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { Field, FormStatus, SubmitButton, inputClass, textareaClass, useActionForm, useActionRunner } from "@/components/ui/form";
import { buttonClass } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";
import { reviewTransferSchema, transferRequestSchema } from "@/lib/validation/schemas";

function Status({ status }: { status: { tone: string; text: string } | null }) {
  if (!status) return null;
  return <p role="status" className={status.tone === "critical" ? "text-xs text-red-700" : "text-xs text-emerald-700"}>{status.text}</p>;
}

/** One-click request from a server-computed recommendation (admin). */
export function CreateFromRecommendationButton({
  recommendationKey,
  medicineId,
  fromFacilityId,
  toFacilityId,
  quantity,
  justification,
  source,
  label,
}: {
  source?: "redistribution" | "expiry";
  label?: string;
  recommendationKey: string;
  medicineId: string;
  fromFacilityId: string;
  toFacilityId: string;
  quantity: number;
  justification: string;
}) {
  const { t } = useI18n();
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        className={buttonClass("teal")}
        disabled={pending || status?.tone === "success"}
        onClick={() =>
          run(() => createTransferRequestAction({ recommendationKey, medicineId, fromFacilityId, toFacilityId, quantity, justification, source: source ?? null }))
        }
      >
        <ArrowRightLeft className="size-4" aria-hidden />
        {pending ? t("common.submitting") : label ?? t("redistribution.createRequest")}
      </button>
      <Status status={status} />
    </div>
  );
}

/** Staff / admin manual request for stock to a facility. */
export function RequestStockButton({
  facilities,
  medicines,
  defaultFacilityId,
}: {
  facilities: { id: string; name: string }[];
  medicines: { id: string; name: string }[];
  defaultFacilityId: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={buttonClass("primary")} onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden />
        {t("transfers.newRequest")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={t("transfers.newRequest")}>
        {open && <RequestForm facilities={facilities} medicines={medicines} defaultFacilityId={defaultFacilityId} onDone={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function RequestForm({
  facilities,
  medicines,
  defaultFacilityId,
  onDone,
}: {
  facilities: { id: string; name: string }[];
  medicines: { id: string; name: string }[];
  defaultFacilityId: string | null;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status } = useActionForm(transferRequestSchema, createTransferRequestAction, {
    defaultValues: { toFacilityId: defaultFacilityId ?? "", medicineId: "", fromFacilityId: null, justification: "", recommendationKey: null },
    onSuccess: () => setTimeout(onDone, 700),
  });
  const e = form.formState.errors;
  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      <Field label={t("transfers.to")} error={e.toFacilityId?.message} htmlFor="tr-to">
        <select id="tr-to" className={inputClass} {...form.register("toFacilityId")}>
          <option value="">—</option>
          {facilities.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("transfers.medicine")} error={e.medicineId?.message} htmlFor="tr-med">
        <select id="tr-med" className={inputClass} aria-invalid={!!e.medicineId} {...form.register("medicineId")}>
          <option value="">{t("inventory.selectMedicine")}</option>
          {medicines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("common.quantity")} error={e.quantity?.message} htmlFor="tr-qty">
        <input id="tr-qty" type="number" min={1} inputMode="numeric" className={inputClass} aria-invalid={!!e.quantity} {...form.register("quantity", { valueAsNumber: true })} />
      </Field>
      <Field label={t("transfers.justification")} error={e.justification?.message} htmlFor="tr-just">
        <textarea id="tr-just" className={textareaClass} aria-invalid={!!e.justification} {...form.register("justification")} />
      </Field>
      <p className="text-[12px] text-ink-muted">{t("transfers.donorToAssign")}</p>
      <FormStatus status={status} />
      <div>
        <SubmitButton pending={pending}>{t("common.submit")}</SubmitButton>
      </div>
    </form>
  );
}

/** Admin review: choose donor (if needed), adjust quantity, approve or reject. */
export function ReviewTransferButton({
  transferId,
  donors,
  currentDonor,
  quantity,
}: {
  transferId: string;
  donors: { id: string; name: string }[];
  currentDonor: string | null;
  quantity: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={buttonClass("primary", "sm")} onClick={() => setOpen(true)}>
        {t("transfers.approve")} / {t("transfers.reject")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`${t("transfers.approve")} / ${t("transfers.reject")}`}>
        {open && <ReviewForm transferId={transferId} donors={donors} currentDonor={currentDonor} quantity={quantity} onDone={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function ReviewForm({
  transferId,
  donors,
  currentDonor,
  quantity,
  onDone,
}: {
  transferId: string;
  donors: { id: string; name: string }[];
  currentDonor: string | null;
  quantity: number;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status } = useActionForm(reviewTransferSchema, reviewTransferAction, {
    defaultValues: { transferId, decision: "approve", fromFacilityId: currentDonor ?? "", quantity, notes: "" },
    onSuccess: () => setTimeout(onDone, 700),
  });
  const e = form.formState.errors;
  const decision = form.watch("decision");
  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      <fieldset className="flex gap-4 text-[13px]">
        <legend className="sr-only">{t("common.actions")}</legend>
        <label className="flex items-center gap-1.5">
          <input type="radio" value="approve" className="accent-brand-600" {...form.register("decision")} />
          {t("transfers.approve")}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" value="reject" className="accent-red-600" {...form.register("decision")} />
          {t("transfers.reject")}
        </label>
      </fieldset>
      {decision === "approve" && (
        <>
          <Field label={t("transfers.selectDonor")} error={e.fromFacilityId?.message} htmlFor="rv-donor">
            <select id="rv-donor" className={inputClass} {...form.register("fromFacilityId")}>
              <option value="">—</option>
              {donors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("common.quantity")} error={e.quantity?.message} htmlFor="rv-qty">
            <input id="rv-qty" type="number" min={1} inputMode="numeric" className={inputClass} {...form.register("quantity", { valueAsNumber: true })} />
          </Field>
        </>
      )}
      <Field
        label={decision === "reject" ? t("transfers.reviewNotes") : `${t("transfers.reviewNotes")} (${t("common.optional")})`}
        error={e.notes?.message}
        htmlFor="rv-notes"
      >
        <textarea id="rv-notes" className={textareaClass} aria-invalid={!!e.notes} {...form.register("notes")} />
      </Field>
      <FormStatus status={status} />
      <div>
        <SubmitButton pending={pending} variant={decision === "reject" ? "danger" : "primary"}>
          {decision === "reject" ? t("transfers.reject") : t("transfers.approve")}
        </SubmitButton>
      </div>
    </form>
  );
}

export function CompleteTransferButton({ transferId }: { transferId: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className={buttonClass("teal", "sm")} onClick={() => setOpen(true)}>
        {t("transfers.complete")}
      </button>
      <Status status={status} />
      <ConfirmDialog
        open={open}
        onCancel={() => setOpen(false)}
        onConfirm={() => run(() => completeTransferAction({ transferId }), () => setOpen(false))}
        title={t("transfers.complete")}
        body={t("transfers.completeConfirm")}
        confirmLabel={t("common.confirm")}
        tone="teal"
        pending={pending}
      />
    </div>
  );
}

export function CancelTransferButton({ transferId }: { transferId: string }) {
  const { t } = useI18n();
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className={buttonClass("secondary", "sm")} disabled={pending} onClick={() => run(() => cancelTransferAction({ transferId }))}>
        {t("transfers.cancel")}
      </button>
      <Status status={status} />
    </div>
  );
}
