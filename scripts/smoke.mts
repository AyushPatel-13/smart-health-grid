/* Smoke test: fetch every page as each demo role against a running dev
 * server (demo mode) and report HTTP status + server-error markers.
 *   npx tsx scripts/smoke.mts [baseUrl]
 * Uses the demo-mode session format; never works against Supabase mode. */
import { createHmac } from "node:crypto";
import { openPGlite } from "../src/lib/db/backends";

const base = process.argv[2] ?? "http://localhost:3000";
const secret = process.env.SHG_SESSION_SECRET ?? "shg-demo-only-insecure-session-secret-change-me";
const cookieFor = (uid: string) => {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
  return `shg_session=${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
};

// Read user ids directly (dev server must not hold the lock — use a copy-free read via HTTP instead if locked).
async function userIds(): Promise<Record<string, string>> {
  const res = await fetch(`${base}/api/health`).catch(() => null);
  void res;
  const db = await openPGlite(process.env.SMOKE_DB ?? ".data/pglite").catch(() => null);
  if (!db) throw new Error("Cannot open DB (stop the dev server or pass ids)");
  const r = await db.query<{ email: string; id: string }>("select email, id from public.profiles");
  await db.close();
  return Object.fromEntries(r.rows.map((x) => [x.email.split("@")[0], x.id]));
}

const pages = [
  "/dashboard", "/facilities", "/alerts", "/queue", "/allocation", "/inventory", "/distribution", "/footfall", "/beds",
  "/attendance", "/workforce", "/my-attendance", "/diagnostics", "/forecasts", "/risk", "/redistribution", "/transfers",
  "/reports", "/audit", "/admin", "/admin?tab=users", "/twin", "/register", "/patient", "/api/reports/stock",
];

const ids = process.env.SMOKE_IDS ? JSON.parse(process.env.SMOKE_IDS) : await userIds();
for (const role of ["admin", "staff.amarpur", "official", "doctor.sundarpur"]) {
  const uid = ids[role];
  if (!uid) continue;
  const results: string[] = [];
  for (const p of pages) {
    const r = await fetch(base + p, { headers: { cookie: cookieFor(uid) }, redirect: "manual" });
    const body = r.status === 200 ? await r.text() : "";
    const bad = /digest\\":\\"|"digest":"|Unhandled Runtime Error/.test(body);
    results.push(`${r.status}${bad ? "!" : ""} ${p}${r.status >= 300 && r.status < 400 ? ` → ${r.headers.get("location")}` : ""}`);
  }
  console.log(`\n== ${role}\n` + results.join("\n"));
}
