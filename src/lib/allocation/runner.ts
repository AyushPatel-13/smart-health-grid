import { withSystem } from "../db";
import { claimWindow, dueWindows, ensureOpenWindow, markWindowFailed, processClaimedWindow } from "./service";

/**
 * Process every window whose cutoff has passed. Safe to call from any number
 * of triggers concurrently (scheduler tick, cron endpoint, admin retry):
 * each window is claimed atomically and processed in a single transaction.
 */
export async function runDueAllocations(trigger: string) {
  const due = await withSystem((q) => dueWindows(q));
  const results: { windowId: string; status: "completed" | "failed" | "skipped"; error?: string }[] = [];
  for (const w of due) {
    const claimed = await withSystem((q) => claimWindow(q, w.id, trigger));
    if (!claimed) {
      results.push({ windowId: w.id, status: "skipped" });
      continue;
    }
    try {
      const r = await withSystem((q) => processClaimedWindow(q, w.id));
      results.push({ windowId: w.id, status: r.skipped ? "skipped" : "completed" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[shg] allocation window ${w.id} failed:`, msg);
      await withSystem((q) => markWindowFailed(q, w.id, msg));
      results.push({ windowId: w.id, status: "failed", error: msg });
    }
  }
  // Keep a window open for new registrations.
  await withSystem((q) => ensureOpenWindow(q));
  return results;
}
