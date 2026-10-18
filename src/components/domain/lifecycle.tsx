import { Check } from "lucide-react";
import type { TxFunction } from "@/lib/i18n";
import { cn } from "@/components/ui/primitives";

const STEPS = [
  "shortage_detected",
  "recommendation_created",
  "awaiting_approval",
  "approved",
  "dispatched",
  "received",
  "replenishment_pending",
  "stock_restored",
  "closed",
] as const;

/** Map a transfer's status + recorded events to the lifecycle position. */
export function lifecycleIndex(status: string, events: string[]): number {
  if (status === "closed") return 8;
  if (events.includes("stock_restored")) return 7;
  if (status === "replenishment_pending") return 6;
  if (status === "received") return 5;
  if (status === "dispatched") return 4;
  if (status === "approved") return 3;
  if (status === "pending") return 2;
  return events.includes("recommendation_created") ? 1 : 0;
}

export function LifecycleStepper({ status, events, tx, compact }: { status: string; events: string[]; tx: TxFunction; compact?: boolean }) {
  const failed = status === "failed" || status === "rejected" || status === "cancelled";
  const at = lifecycleIndex(status, events);
  return (
    <ol className={cn("flex flex-wrap items-center gap-1", compact ? "text-[10px]" : "text-[11px]")} aria-label="Lifecycle">
      {STEPS.map((s, i) => {
        const done = i < at || (i === at && s === "closed");
        const current = i === at && !failed && s !== "closed";
        return (
          <li key={s} className="flex items-center gap-1">
            <span
              className={cn(
                "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 ring-1 ring-inset",
                done && "bg-emerald-50 text-emerald-800 ring-emerald-200",
                current && "bg-brand-600 text-white ring-brand-600",
                !done && !current && "bg-white text-ink-faint ring-line",
              )}
              aria-current={current ? "step" : undefined}
            >
              {done && <Check className="size-3" aria-hidden />}
              {tx(`distribution.step.${s}`)}
            </span>
            {i < STEPS.length - 1 && <span className="text-ink-faint" aria-hidden>›</span>}
          </li>
        );
      })}
      {failed && <li className="rounded-full bg-red-50 px-1.5 py-0.5 text-red-700 ring-1 ring-red-200">{tx(`transferStatus.${status}`)}</li>}
    </ol>
  );
}
