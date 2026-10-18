import path from "node:path";
import { getDataMode } from "../env";
import { migratePGlite, openPGlite, pgliteBackend, postgresBackend } from "./backends";
import { toDbError, type DbBackend, type Queryable } from "./types";

export type { Queryable } from "./types";
export { DbError, toDbError } from "./types";

type Globals = { __shgDb?: Promise<DbBackend>; __shgPglite?: import("@electric-sql/pglite").PGlite };
const g = globalThis as unknown as Globals;

function pgliteDataDir(): string | undefined {
  // Serverless hosts have a read-only filesystem: fall back to in-memory.
  if (process.env.VERCEL || process.env.PGLITE_IN_MEMORY === "1") return undefined;
  return path.resolve(process.cwd(), process.env.PGLITE_DATA_DIR ?? ".data/pglite");
}

async function initBackend(): Promise<DbBackend> {
  if (getDataMode() === "supabase") {
    return postgresBackend(process.env.DATABASE_URL!);
  }
  const db = await openPGlite(pgliteDataDir());
  g.__shgPglite = db;
  await migratePGlite(db);
  const backend = pgliteBackend(db);
  const { isSeeded, seedDemoData } = await import("./seed");
  const seeded = await backend.transaction((q) => isSeeded(q));
  if (!seeded) {
    console.log("[shg] Seeding synthetic demo dataset…");
    await seedDemoData(backend);
  }
  return backend;
}

export function getDb(): Promise<DbBackend> {
  if (!g.__shgDb) {
    g.__shgDb = initBackend().catch((err) => {
      g.__shgDb = undefined;
      throw err;
    });
  }
  return g.__shgDb;
}

async function configureTx(q: Queryable, userId: string | null) {
  await q.query(`select set_config('timezone', 'Asia/Kolkata', true)`);
  if (userId) {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await q.query(
      `select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)`,
      [claims, userId],
    );
    await q.query(`set local role authenticated`);
  }
}

/**
 * Run queries as an authenticated user. Row Level Security policies are
 * enforced by Postgres for everything executed inside fn.
 */
export async function withUser<R>(userId: string, fn: (q: Queryable) => Promise<R>): Promise<R> {
  const db = await getDb();
  try {
    return await db.transaction(async (q) => {
      await configureTx(q, userId);
      return fn(q);
    });
  } catch (err) {
    throw toDbError(err);
  }
}

/**
 * Trusted system context (bypasses RLS). Used only for session lookup, the
 * deterministic alert engine and seeding — never with client-chosen queries.
 */
export async function withSystem<R>(fn: (q: Queryable) => Promise<R>): Promise<R> {
  const db = await getDb();
  try {
    return await db.transaction(async (q) => {
      await configureTx(q, null);
      return fn(q);
    });
  } catch (err) {
    throw toDbError(err);
  }
}

/** Demo mode only: wipe and re-seed the embedded database in place. */
export async function resetDemoDatabase(): Promise<void> {
  if (getDataMode() !== "demo") throw new Error("Reset is only available in demo mode");
  const backend = await getDb();
  const { seedDemoData } = await import("./seed");
  await seedDemoData(backend, { reset: true });
}
