"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type ReactNode } from "react";
import { useForm, type DefaultValues, type FieldValues, type Resolver } from "react-hook-form";
import type { z } from "zod";
import type { ActionResult } from "@/lib/actions/result";
import { useI18n } from "@/lib/i18n/client";
import { cn, Notice } from "./primitives";

export const inputClass =
  "h-9 w-full rounded-lg border border-line bg-white px-2.5 text-sm text-ink placeholder:text-ink-faint aria-[invalid=true]:border-red-500 disabled:bg-slate-50";
export const textareaClass =
  "min-h-[72px] w-full rounded-lg border border-line bg-white px-2.5 py-2 text-sm text-ink placeholder:text-ink-faint aria-[invalid=true]:border-red-500";

export function Field({
  label,
  error,
  hint,
  children,
  className,
  htmlFor,
}: {
  label: ReactNode;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  const { tx } = useI18n();
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-ink-muted">{hint}</p>}
      {error && (
        <p className="text-xs font-medium text-red-700" role="alert">
          {tx(error)}
        </p>
      )}
    </div>
  );
}

type Status = { tone: "success" | "critical"; text: string } | null;

/**
 * React Hook Form + Zod on the client, the same Zod schema re-validated by the
 * server action. Server field errors are mapped back onto the form.
 */
export function useActionForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  action: (values: z.infer<S>) => Promise<ActionResult>,
  opts: { defaultValues?: DefaultValues<z.infer<S>>; resetOnSuccess?: boolean; onSuccess?: (r: ActionResult) => void } = {},
) {
  const { tx } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>(null);
  const form = useForm<z.infer<S>>({
    resolver: zodResolver(schema as never) as unknown as Resolver<z.infer<S>>,
    defaultValues: opts.defaultValues,
  });

  const onSubmit = form.handleSubmit((values) => {
    setStatus(null);
    startTransition(async () => {
      try {
        const res = await action(values);
        if (res.ok) {
          setStatus({ tone: "success", text: tx(res.message ?? "common.saved", res.params) });
          if (opts.resetOnSuccess) form.reset(opts.defaultValues);
          opts.onSuccess?.(res);
          router.refresh();
        } else {
          for (const [field, msg] of Object.entries(res.fieldErrors ?? {})) {
            form.setError(field as never, { type: "server", message: msg });
          }
          setStatus({ tone: "critical", text: tx(`errors.${res.error}`) === `errors.${res.error}` ? tx(res.error) : tx(`errors.${res.error}`) });
        }
      } catch {
        setStatus({ tone: "critical", text: tx("errors.UNKNOWN") });
      }
    });
  });

  return { form, onSubmit, pending, status, setStatus };
}

export function FormStatus({ status }: { status: Status }) {
  if (!status) return null;
  return <Notice tone={status.tone}>{status.text}</Notice>;
}

export function SubmitButton({ pending, children, variant = "primary", className }: { pending: boolean; children: ReactNode; variant?: "primary" | "teal" | "danger"; className?: string }) {
  const { t } = useI18n();
  const colors = {
    primary: "bg-brand-600 hover:bg-brand-700",
    teal: "bg-teal-600 hover:bg-teal-700",
    danger: "bg-red-600 hover:bg-red-700",
  }[variant];
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={cn("inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-medium text-white disabled:opacity-60", colors, className)}
    >
      {pending ? t("common.submitting") : children}
    </button>
  );
}

/** Stable id helper for label/input pairing. */
export function useFieldId(name: string) {
  const id = useId();
  return `${name}-${id}`;
}

/** Translate a server action result for one-off (non-form) buttons. */
export function useActionRunner() {
  const { tx } = useI18n();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState<Status>(null);
  const run = (fn: () => Promise<ActionResult>, after?: (r: ActionResult) => void) => {
    setStatus(null);
    startTransition(async () => {
      try {
        const res = await fn();
        if (res.ok) {
          setStatus({ tone: "success", text: tx(res.message ?? "common.saved", res.params) });
          router.refresh();
        } else {
          const key = tx(`errors.${res.error}`) === `errors.${res.error}` ? res.error : `errors.${res.error}`;
          setStatus({ tone: "critical", text: tx(key) });
        }
        after?.(res);
      } catch {
        setStatus({ tone: "critical", text: tx("errors.UNKNOWN") });
      }
    });
  };
  return { run, pending, status, setStatus };
}
