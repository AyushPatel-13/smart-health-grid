"use client";

import { useState } from "react";
import { Database, RotateCcw } from "lucide-react";
import { resetDemoAction, saveForecastSnapshotAction } from "@/app/actions/admin";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useActionRunner } from "@/components/ui/form";
import { buttonClass } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";

function StatusLine({ status }: { status: { tone: string; text: string } | null }) {
  if (!status) return null;
  return (
    <p role="status" className={status.tone === "critical" ? "text-xs text-red-700" : "text-xs text-emerald-700"}>
      {status.text}
    </p>
  );
}

export function SnapshotButton() {
  const { t } = useI18n();
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" className={buttonClass("secondary")} disabled={pending} onClick={() => run(() => saveForecastSnapshotAction())}>
        <Database className="size-4" aria-hidden />
        {pending ? t("common.submitting") : t("forecasts.snapshot")}
      </button>
      <StatusLine status={status} />
    </div>
  );
}

export function ResetDemoButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { run, pending, status } = useActionRunner();
  return (
    <div className="flex flex-col items-start gap-1">
      <button type="button" className={buttonClass("danger")} onClick={() => setOpen(true)}>
        <RotateCcw className="size-4" aria-hidden />
        {t("demo.resetTitle")}
      </button>
      <StatusLine status={status} />
      <ConfirmDialog
        open={open}
        onCancel={() => setOpen(false)}
        onConfirm={() => run(() => resetDemoAction(), () => setOpen(false))}
        title={t("demo.resetTitle")}
        body={t("demo.resetBody")}
        confirmLabel={t("common.confirm")}
        tone="danger"
        pending={pending}
      />
    </div>
  );
}
