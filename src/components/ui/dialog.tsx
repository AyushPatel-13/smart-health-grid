"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";
import { buttonClass, cn } from "./primitives";

/** Accessible modal built on the native <dialog> (focus trap + Esc for free). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
      aria-labelledby="dialog-title"
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-xl border border-line bg-surface p-0 text-ink shadow-xl",
        wide ? "max-w-2xl" : "max-w-md",
      )}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h2 id="dialog-title" className="text-base font-semibold">
              {title}
            </h2>
            <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-muted hover:bg-slate-100" aria-label={t("common.close")}>
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel,
  tone = "primary",
  pending,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: ReactNode;
  tone?: "primary" | "danger" | "teal";
  pending?: boolean;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      <p className="text-sm text-ink-muted">{body}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={buttonClass("secondary")} onClick={onCancel}>
          {t("common.cancel")}
        </button>
        <button type="button" className={buttonClass(tone)} onClick={onConfirm} disabled={pending} autoFocus>
          {pending ? t("common.submitting") : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
