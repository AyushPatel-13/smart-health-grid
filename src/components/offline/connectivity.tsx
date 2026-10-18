"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import { checkInAction, registerAction } from "@/app/actions/patients";
import { issueAction } from "@/app/actions/inventory";
import { useI18n } from "@/lib/i18n/client";
import { QUEUE_EVENT, flushQueue, listQueued, removeQueued, type Handler, type OfflineItem, type OfflineKind } from "@/lib/offline/queue";

const handlers: Record<OfflineKind, Handler> = {
  register: (p) => registerAction(p),
  checkin: (p) => checkInAction(p),
  issue: (p) => issueAction(p),
};

/**
 * Connectivity banner + offline queue synchroniser. Shows offline state,
 * queued submissions, sync results and conflicts that need review.
 */
export function ConnectivityBar() {
  const { t, tx } = useI18n();
  const router = useRouter();
  const [online, setOnline] = useState(true);
  const [items, setItems] = useState<OfflineItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => setItems(listQueued()), []);

  const sync = useCallback(async () => {
    const outcomes = await flushQueue(handlers);
    refresh();
    if (outcomes.length) {
      const okRegs = outcomes.filter((o) => o.ok && o.item.kind === "register");
      const parts = [t("offline.synced", { n: outcomes.filter((o) => o.ok).length })];
      for (const r of okRegs) {
        const d = r.data as { patientCode?: string; pin?: string } | undefined;
        if (d?.patientCode) parts.push(t("offline.registered", { code: d.patientCode, pin: d.pin ?? "—" }));
      }
      setNotice(parts.join(" "));
      router.refresh();
    }
  }, [refresh, router, t]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    const goOnline = () => {
      update();
      void sync();
    };
    const init = setTimeout(() => {
      update();
      refresh();
      void sync();
    }, 0);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", update);
    window.addEventListener(QUEUE_EVENT, refresh);
    const id = setInterval(() => navigator.onLine && void sync(), 30_000);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", update);
      window.removeEventListener(QUEUE_EVENT, refresh);
      clearInterval(id);
      clearTimeout(init);
    };
  }, [refresh, sync]);

  const queued = items.filter((i) => i.status === "queued");
  const failed = items.filter((i) => i.status === "failed");
  if (online && !queued.length && !failed.length && !notice) return null;

  return (
    <div className="no-print space-y-1 border-b border-line bg-white px-4 py-2 text-[13px]" role="status" aria-live="polite">
      {!online && (
        <p className="flex items-center gap-2 font-medium text-amber-800">
          <CloudOff className="size-4" aria-hidden /> {t("offline.offline")}
        </p>
      )}
      {queued.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-ink-muted">
          {t("offline.queued", { n: queued.length })}
          {online && (
            <button type="button" onClick={() => void sync()} className="inline-flex items-center gap-1 rounded border border-line px-2 py-0.5 text-[12px] hover:bg-slate-50">
              <RefreshCw className="size-3" aria-hidden /> {t("offline.syncNow")}
            </button>
          )}
        </p>
      )}
      {failed.map((f) => (
        <p key={f.id} className="flex flex-wrap items-center gap-2 text-red-700">
          {t("offline.conflict", { kind: tx(`offline.kinds.${f.kind}`) })}: {tx(f.error?.includes(".") ? f.error : `errors.${f.error ?? "UNKNOWN"}`)}
          <button type="button" onClick={() => removeQueued(f.id)} className="rounded border border-red-200 px-2 py-0.5 text-[12px]">
            {t("offline.dismiss")}
          </button>
        </p>
      ))}
      {notice && (
        <p className="flex flex-wrap items-center gap-2 text-emerald-800">
          {notice}
          <button type="button" onClick={() => setNotice(null)} className="rounded border border-emerald-200 px-2 py-0.5 text-[12px]">
            {t("offline.dismiss")}
          </button>
        </p>
      )}
    </div>
  );
}

/** Registers the service worker (production only) for static-asset caching and an offline fallback. */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
