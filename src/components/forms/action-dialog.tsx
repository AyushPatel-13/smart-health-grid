"use client";

import { useState } from "react";
import type { ActionResult } from "@/lib/actions/result";
import { Dialog } from "@/components/ui/dialog";
import { Field, inputClass, textareaClass, useActionRunner } from "@/components/ui/form";
import { Notice, buttonClass, cn } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";

export interface DialogField {
  name: string;
  label: string;
  type: "number" | "text" | "date" | "textarea";
  defaultValue?: string | number;
  hint?: string;
  min?: number;
  max?: number;
}

type Variant = "primary" | "secondary" | "teal" | "danger";

/**
 * Reusable "button → dialog form → server action" control. Server-side Zod
 * validation errors and DB error codes are shown translated in the dialog.
 */
export function ActionDialogButton({
  label,
  title,
  description,
  fields,
  submitLabel,
  variant = "primary",
  size = "sm",
  action,
}: {
  label: string;
  title: string;
  description?: React.ReactNode;
  fields: DialogField[];
  submitLabel?: string;
  variant?: Variant;
  size?: "sm" | "md";
  action: (values: Record<string, string | number | null>) => Promise<ActionResult>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.defaultValue === undefined ? "" : String(f.defaultValue)])),
  );
  const { run, pending, status } = useActionRunner();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: Record<string, string | number | null> = {};
    for (const f of fields) {
      const v = values[f.name];
      payload[f.name] = f.type === "number" ? (v === "" ? null : Number(v)) : v === "" ? null : v;
    }
    run(() => action(payload), (r) => r.ok && setTimeout(() => setOpen(false), 700));
  };
  return (
    <>
      <button type="button" className={cn(buttonClass(variant, size), size === "sm" && "h-7 px-2 text-xs")} onClick={() => setOpen(true)}>
        {label}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={title}>
        {open && (
          <form onSubmit={submit} className="grid gap-3" noValidate>
            {description && <div className="text-[13px] text-ink-muted">{description}</div>}
            {fields.map((f) => (
              <Field key={f.name} label={f.label} hint={f.hint} htmlFor={`adf-${f.name}`}>
                {f.type === "textarea" ? (
                  <textarea id={`adf-${f.name}`} className={textareaClass} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                ) : (
                  <input
                    id={`adf-${f.name}`}
                    type={f.type}
                    min={f.min}
                    max={f.max}
                    inputMode={f.type === "number" ? "numeric" : undefined}
                    className={inputClass}
                    value={values[f.name]}
                    onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  />
                )}
              </Field>
            ))}
            {status && <Notice tone={status.tone}>{status.text}</Notice>}
            <div>
              <button type="submit" disabled={pending} className={buttonClass(variant === "secondary" ? "primary" : variant)}>
                {pending ? t("common.submitting") : submitLabel ?? label}
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}

/** One-click action with inline status. */
export function ActionButton({ label, variant = "secondary", action }: { label: string; variant?: Variant; action: () => Promise<ActionResult> }) {
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-0.5">
      <button type="button" disabled={pending} className={cn(buttonClass(variant, "sm"), "h-7 px-2 text-xs")} onClick={() => run(action)}>
        {label}
      </button>
      {status && <p className={status.tone === "critical" ? "text-[11px] text-red-700" : "text-[11px] text-emerald-700"}>{status.text}</p>}
    </div>
  );
}
