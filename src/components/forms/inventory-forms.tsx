"use client";

import { useState } from "react";
import { addBatchAction, adjustmentAction, issueAction, receiptAction, writeOffAction } from "@/app/actions/inventory";
import { Field, FormStatus, SubmitButton, inputClass, textareaClass, useActionForm } from "@/components/ui/form";
import { cn } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";
import { BATCH_SOURCES, addBatchSchema, adjustmentSchema, issueSchema, receiptSchema, writeOffSchema } from "@/lib/validation/schemas";

export interface MedicineOption {
  id: string;
  name: string;
  unit: string;
  usable: number;
}
export interface BatchOption {
  id: string;
  medicineId: string;
  label: string;
  expired: boolean;
  quantity: number;
}

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const num = { valueAsNumber: true } as const;

type Mode = "issue" | "batch" | "receipt" | "adjustment" | "writeoff";

export function InventoryForms({ facilityId, medicines, batches }: { facilityId: string; medicines: MedicineOption[]; batches: BatchOption[] }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("issue");
  const modes: { key: Mode; label: string }[] = [
    { key: "issue", label: t("inventory.recordIssue") },
    { key: "batch", label: t("inventory.addBatch") },
    { key: "receipt", label: t("inventory.recordReceipt") },
    { key: "adjustment", label: t("inventory.recordAdjustment") },
    { key: "writeoff", label: t("inventory.writeOff") },
  ];
  return (
    <div>
      <div role="tablist" className="mb-4 flex flex-wrap gap-1.5">
        {modes.map((m) => (
          <button
            key={m.key}
            role="tab"
            type="button"
            aria-selected={mode === m.key}
            onClick={() => setMode(m.key)}
            className={cn(
              "rounded-full px-3 py-1 text-[13px] font-medium ring-1 ring-inset",
              mode === m.key ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-ink-muted ring-line hover:text-ink",
            )}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === "issue" && <IssueForm facilityId={facilityId} medicines={medicines} />}
      {mode === "batch" && <AddBatchForm facilityId={facilityId} medicines={medicines} />}
      {mode === "receipt" && <BatchMovementForm kind="receipt" batches={batches.filter((b) => !b.expired)} />}
      {mode === "adjustment" && <BatchMovementForm kind="adjustment" batches={batches} />}
      {mode === "writeoff" && <BatchMovementForm kind="writeoff" batches={batches.filter((b) => b.expired)} />}
    </div>
  );
}

function IssueForm({ facilityId, medicines }: { facilityId: string; medicines: MedicineOption[] }) {
  const { t } = useI18n();
  const [key, setKey] = useState(newKey);
  const { form, onSubmit, pending, status } = useActionForm(issueSchema, issueAction, {
    defaultValues: { facilityId, idempotencyKey: key, medicineId: "", reason: "" },
    onSuccess: () => {
      const k = newKey();
      setKey(k);
      form.reset({ facilityId, idempotencyKey: k, medicineId: form.getValues("medicineId"), reason: "" });
    },
  });
  const e = form.formState.errors;
  const selected = medicines.find((m) => m.id === form.watch("medicineId"));
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label={t("inventory.medicine")} error={e.medicineId?.message} htmlFor="issue-med">
        <select id="issue-med" className={inputClass} aria-invalid={!!e.medicineId} {...form.register("medicineId")}>
          <option value="">{t("inventory.selectMedicine")}</option>
          {medicines.map((m) => (
            <option key={m.id} value={m.id} disabled={m.usable <= 0}>
              {m.name} ({m.usable})
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={`${t("common.quantity")}${selected ? ` (${t(`units.${selected.unit as "tablet"}`)})` : ""}`}
        error={e.quantity?.message}
        hint={t("inventory.issueHint")}
        htmlFor="issue-qty"
      >
        <input id="issue-qty" type="number" min={1} step={1} inputMode="numeric" className={inputClass} aria-invalid={!!e.quantity} {...form.register("quantity", num)} />
      </Field>
      <Field label={`${t("common.notes")} (${t("common.optional")})`} error={e.reason?.message} className="sm:col-span-2" htmlFor="issue-notes">
        <input id="issue-notes" className={inputClass} {...form.register("reason")} />
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <FormStatus status={status} />
        <div>
          <SubmitButton pending={pending}>{t("inventory.recordIssue")}</SubmitButton>
        </div>
      </div>
    </form>
  );
}

function AddBatchForm({ facilityId, medicines }: { facilityId: string; medicines: MedicineOption[] }) {
  const { t } = useI18n();
  const [key, setKey] = useState(newKey);
  const defaults = { facilityId, idempotencyKey: key, medicineId: "", batchNumber: "", expiryDate: "", supplier: "", source: "state_supply" as const };
  const { form, onSubmit, pending, status } = useActionForm(addBatchSchema, addBatchAction, {
    defaultValues: defaults,
    onSuccess: () => {
      const k = newKey();
      setKey(k);
      form.reset({ ...defaults, idempotencyKey: k });
    },
  });
  const e = form.formState.errors;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" noValidate>
      <Field label={t("inventory.medicine")} error={e.medicineId?.message} htmlFor="b-med">
        <select id="b-med" className={inputClass} aria-invalid={!!e.medicineId} {...form.register("medicineId")}>
          <option value="">{t("inventory.selectMedicine")}</option>
          {medicines.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("inventory.batchNumber")} error={e.batchNumber?.message} htmlFor="b-no">
        <input id="b-no" className={inputClass} aria-invalid={!!e.batchNumber} autoComplete="off" {...form.register("batchNumber")} />
      </Field>
      <Field label={t("common.quantity")} error={e.quantity?.message} htmlFor="b-qty">
        <input id="b-qty" type="number" min={1} step={1} inputMode="numeric" className={inputClass} aria-invalid={!!e.quantity} {...form.register("quantity", num)} />
      </Field>
      <Field label={t("inventory.expiry")} error={e.expiryDate?.message} htmlFor="b-exp">
        <input id="b-exp" type="date" className={inputClass} aria-invalid={!!e.expiryDate} {...form.register("expiryDate")} />
      </Field>
      <Field label={t("inventory.source")} error={e.source?.message} htmlFor="b-src">
        <select id="b-src" className={inputClass} {...form.register("source")}>
          {BATCH_SOURCES.map((s) => (
            <option key={s} value={s}>
              {t(`inventory.sources.${s}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={`${t("inventory.supplier")} (${t("common.optional")})`} error={e.supplier?.message} htmlFor="b-sup">
        <input id="b-sup" className={inputClass} {...form.register("supplier")} />
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-3">
        <FormStatus status={status} />
        <div>
          <SubmitButton pending={pending}>{t("inventory.addBatch")}</SubmitButton>
        </div>
      </div>
    </form>
  );
}

function BatchMovementForm({ kind, batches }: { kind: "receipt" | "adjustment" | "writeoff"; batches: BatchOption[] }) {
  const { t } = useI18n();
  const [key, setKey] = useState(newKey);
  const schema = kind === "receipt" ? receiptSchema : kind === "adjustment" ? adjustmentSchema : writeOffSchema;
  const action = kind === "receipt" ? receiptAction : kind === "adjustment" ? adjustmentAction : writeOffAction;
  const { form, onSubmit, pending, status } = useActionForm(schema as typeof receiptSchema, action, {
    defaultValues: { batchId: "", idempotencyKey: key, reason: "" },
    onSuccess: () => {
      const k = newKey();
      setKey(k);
      form.reset({ batchId: "", idempotencyKey: k, reason: "" });
    },
  });
  const e = form.formState.errors;
  const label = kind === "receipt" ? t("inventory.recordReceipt") : kind === "adjustment" ? t("inventory.recordAdjustment") : t("inventory.writeOff");
  const selected = batches.find((b) => b.id === form.watch("batchId"));
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label={t("inventory.batches")} error={e.batchId?.message} htmlFor={`${kind}-batch`}>
        <select id={`${kind}-batch`} className={inputClass} aria-invalid={!!e.batchId} {...form.register("batchId")}>
          <option value="">{t("inventory.selectBatch")}</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label={t("common.quantity")}
        error={e.quantity?.message}
        hint={kind === "adjustment" ? t("inventory.adjustmentHint") : kind === "writeoff" && selected ? `${t("inventory.available")}: ${selected.quantity}` : undefined}
        htmlFor={`${kind}-qty`}
      >
        <input
          id={`${kind}-qty`}
          type="number"
          step={1}
          min={kind === "adjustment" ? undefined : 1}
          inputMode="numeric"
          className={inputClass}
          aria-invalid={!!e.quantity}
          {...form.register("quantity", num)}
        />
      </Field>
      <Field
        label={kind === "adjustment" ? t("common.reason") : `${t("common.reason")} (${t("common.optional")})`}
        error={e.reason?.message}
        className="sm:col-span-2"
        htmlFor={`${kind}-reason`}
      >
        <textarea id={`${kind}-reason`} className={textareaClass} aria-invalid={!!e.reason} {...form.register("reason")} />
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <FormStatus status={status} />
        <div>
          <SubmitButton pending={pending} variant={kind === "writeoff" ? "danger" : "primary"}>
            {label}
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}
