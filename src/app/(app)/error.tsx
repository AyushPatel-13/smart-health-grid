"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n/client";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className="mx-auto mt-10 max-w-md rounded-xl border border-red-200 bg-white p-6 text-center">
      <AlertTriangle className="mx-auto size-8 text-red-600" aria-hidden />
      <h1 className="mt-3 text-lg font-semibold">{t("common.error")}</h1>
      <p className="mt-1 text-sm text-ink-muted">{t("errors.UNKNOWN")}</p>
      {error.digest && <p className="mt-2 font-mono text-[11px] text-ink-faint">ref: {error.digest}</p>}
      <button type="button" onClick={reset} className="mt-4 h-9 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700">
        {t("common.retry")}
      </button>
    </div>
  );
}
