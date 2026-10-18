import { migratePGlite, openPGlite, pgliteBackend } from "@/lib/db/backends";
import { seedDemoData, DEMO_ACCOUNTS } from "@/lib/db/seed";
import type { DbBackend, Queryable } from "@/lib/db/types";

export interface TestDb {
  backend: DbBackend;
  close: () => Promise<void>;
  /** Run as the system (bypasses RLS). */
  sys: <R>(fn: (q: Queryable) => Promise<R>) => Promise<R>;
  /** Run as a user (RLS enforced, exactly like the app). */
  as: <R>(userId: string, fn: (q: Queryable) => Promise<R>) => Promise<R>;
  user: (key: string) => Promise<string>;
}

/** Fresh in-memory database with all migrations and the synthetic seed. */
export async function createTestDb(): Promise<TestDb> {
  const db = await openPGlite();
  await migratePGlite(db);
  const backend = pgliteBackend(db);
  await seedDemoData(backend);
  const sys: TestDb["sys"] = (fn) =>
    backend.transaction(async (q) => {
      await q.query(`select set_config('timezone', 'Asia/Kolkata', true)`);
      return fn(q);
    });
  const as: TestDb["as"] = (userId, fn) =>
    backend.transaction(async (q) => {
      await q.query(`select set_config('timezone', 'Asia/Kolkata', true)`);
      await q.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: "authenticated" })]);
      await q.query(`set local role authenticated`);
      return fn(q);
    });
  const user = async (key: string) => {
    const email = DEMO_ACCOUNTS.find((a) => a.key === key)!.email;
    const [row] = await sys((q) => q.query<{ id: string }>(`select id from public.profiles where email = $1`, [email]));
    return row.id;
  };
  return { backend, close: () => db.close(), sys, as, user };
}
