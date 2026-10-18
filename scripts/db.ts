/* Database CLI for Smart Health Grid.
 *
 *   npm run db:reset           Recreate the embedded demo database (PGlite) and seed it.
 *   npm run db:summary         Print a summary of derived metrics from the demo database.
 *   npm run db:seed:supabase   Seed a Supabase project (needs DATABASE_URL,
 *                              NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
 *
 * Stop `npm run dev` before running db:reset — PGlite holds an exclusive lock
 * on its data directory. (The in-app "Reset demo data" button works while running.)
 */
import fs from "node:fs";
import path from "node:path";
import { migratePGlite, openPGlite, pgliteBackend, postgresBackend } from "../src/lib/db/backends";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, seedDemoData } from "../src/lib/db/seed";
import { loadSnapshots, toStockPositions } from "../src/lib/data/snapshot";
import { recommendTransfers } from "../src/lib/analytics/redistribution";
import { todayIST } from "../src/lib/dates";

const dataDir = path.resolve(process.cwd(), process.env.PGLITE_DATA_DIR ?? ".data/pglite");

async function reset() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  const db = await openPGlite(dataDir);
  const ran = await migratePGlite(db);
  console.log(`Applied ${ran.length} migration(s).`);
  const t0 = Date.now();
  await seedDemoData(pgliteBackend(db));
  console.log(`Seeded synthetic demo data in ${((Date.now() - t0) / 1000).toFixed(1)}s at ${dataDir}`);
  await db.close();
}

async function summary() {
  const db = await openPGlite(dataDir);
  await migratePGlite(db);
  const backend = pgliteBackend(db);
  const today = todayIST();
  await backend.transaction(async (q) => {
    const snaps = await loadSnapshots(q, { today });
    for (const s of snaps) {
      const c = s.stockCounts;
      console.log(
        `${s.facility.code.padEnd(11)} risk=${String(s.risk.score).padStart(3)} ${s.risk.band.padEnd(6)} ` +
          `stock[out=${c.stock_out} crit=${c.critical} high=${c.high} low=${c.low} ok=${c.ok} none=${c.no_consumption} ins=${c.insufficient_data}] ` +
          `beds=${s.beds.occupied}/${s.beds.total - s.beds.outOfService} docCov=${s.attendance.doctorCoverage} ` +
          `noDocDays=${s.attendance.daysWithoutDoctor.length} unver=${s.attendance.unverifiedOrIncompleteShare} ` +
          `fc=${s.footfall.forecast.method}/${s.footfall.forecast.meanDaily} bt=${JSON.stringify(s.footfall.forecast.backtest?.improvementPct)} ` +
          `spike=${s.footfall.spike.isSpike} alerts=${s.alerts.open}`,
      );
    }
    const recs = recommendTransfers(toStockPositions(snaps), today);
    for (const r of recs) {
      console.log(`REC ${r.medicineName}: ${r.donor.facilityName} -> ${r.recipient.facilityName} qty=${r.quantity} ` +
        `rcpDays ${r.recipient.daysOfStockBefore}->${r.recipient.daysOfStockAfter} donorLeft=${r.donor.remainingAfter} reserve=${r.donor.reserve} km=${r.distanceKm}`);
    }
    const alerts = await q.query<{ category: string; severity: string; n: number }>(
      `select category, severity, count(*)::int n from public.alerts where status <> 'resolved' group by 1,2 order by 1,2`);
    console.log(alerts);
  });
  await db.close();
}

async function seedSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const dbUrl = process.env.DATABASE_URL;
  if (!url || !key || !dbUrl) {
    throw new Error("Set NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and DATABASE_URL first.");
  }
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const ids: Record<string, string> = {};
  const { data: existing } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const a of DEMO_ACCOUNTS) {
    const found = existing?.users.find((u) => u.email === a.email);
    if (found) {
      ids[a.key] = found.id;
      continue;
    }
    const { data, error } = await admin.auth.admin.createUser({
      email: a.email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: a.fullName, demo: true },
    });
    if (error || !data.user) throw error ?? new Error("createUser failed");
    ids[a.key] = data.user.id;
  }
  const backend = await postgresBackend(dbUrl);
  await seedDemoData(backend, { reset: true, authUserIds: ids });
  console.log("Supabase project seeded with synthetic demo data.");
  process.exit(0);
}

const cmd = process.argv[2];
const run = cmd === "reset" ? reset : cmd === "summary" ? summary : cmd === "seed:supabase" ? seedSupabase : null;
if (!run) {
  console.error("Usage: tsx scripts/db.ts <reset|summary|seed:supabase>");
  process.exit(1);
}
run().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
