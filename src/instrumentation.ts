// Server-side scheduler for hourly batch allocation. Runs inside the Node.js
// server process (never in a browser), checks every minute for windows whose
// cutoff has passed and processes them. For serverless deployments, use the
// /api/cron/allocate endpoint with an external scheduler (e.g. Vercel Cron).

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.SHG_SCHEDULER === "off" || process.env.VERCEL) return;
  const g = globalThis as unknown as { __shgScheduler?: NodeJS.Timeout };
  if (g.__shgScheduler) return;
  const tick = async () => {
    try {
      const { runDueAllocations } = await import("./lib/allocation/runner");
      const r = await runDueAllocations("scheduler");
      if (r.some((x) => x.status !== "skipped")) console.log("[shg] scheduler processed windows:", JSON.stringify(r));
    } catch (err) {
      console.error("[shg] scheduler tick failed:", err instanceof Error ? err.message : err);
    }
  };
  g.__shgScheduler = setInterval(tick, 60_000);
  g.__shgScheduler.unref?.();
  setTimeout(tick, 10_000).unref?.();
}
