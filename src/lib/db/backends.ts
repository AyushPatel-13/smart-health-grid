import fs from "node:fs";
import path from "node:path";
import type { DbBackend, Queryable } from "./types";

// Normalise column types so both backends return identical JS values:
//   date -> "YYYY-MM-DD", timestamp(tz) -> ISO string, numeric/int8 -> number.
const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 };

function parseTimestamp(v: string): string {
  let s = v.replace(" ", "T");
  if (/[+-]\d\d$/.test(s)) s += ":00";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const SHIM_FILE = path.join(process.cwd(), "db", "pglite-supabase-shim.sql");

export function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

export function readMigration(name: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8");
}

// ---------------------------------------------------------------------------
// PGlite (embedded Postgres) — demo mode
// ---------------------------------------------------------------------------
type PGliteInstance = import("@electric-sql/pglite").PGlite;

export async function openPGlite(dataDir?: string): Promise<PGliteInstance> {
  const { PGlite } = await import("@electric-sql/pglite");
  const parsers = {
    [OID.INT8]: (v: string) => Number(v),
    [OID.NUMERIC]: (v: string) => Number(v),
    [OID.DATE]: (v: string) => v,
    [OID.TIMESTAMP]: (v: string) => parseTimestamp(v),
    [OID.TIMESTAMPTZ]: (v: string) => parseTimestamp(v),
  };
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const db = dataDir ? new PGlite(dataDir, { parsers }) : new PGlite({ parsers });
  await db.waitReady;
  await db.exec(`set timezone = 'Asia/Kolkata'`);
  return db;
}

/** Apply the Supabase shim + every migration not yet applied. */
export async function migratePGlite(db: PGliteInstance): Promise<string[]> {
  await db.exec(`create schema if not exists app_meta;
    create table if not exists app_meta.migrations (name text primary key, applied_at timestamptz not null default now());`);
  const applied = new Set(
    (await db.query<{ name: string }>("select name from app_meta.migrations")).rows.map((r) => r.name),
  );
  const ran: string[] = [];
  if (!applied.has("_shim")) {
    await db.exec(fs.readFileSync(SHIM_FILE, "utf8"));
    await db.query("insert into app_meta.migrations (name) values ('_shim')");
  }
  for (const file of listMigrationFiles()) {
    if (applied.has(file)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(readMigration(file));
      await tx.query("insert into app_meta.migrations (name) values ($1)", [file]);
    });
    ran.push(file);
  }
  return ran;
}

export function pgliteBackend(db: PGliteInstance): DbBackend {
  return {
    kind: "pglite",
    transaction: (fn) =>
      db.transaction(async (tx) => {
        const q: Queryable = {
          query: async <T,>(text: string, params?: unknown[]) =>
            (await tx.query<T>(text, params as unknown[])).rows,
        };
        return fn(q);
      }),
  };
}

// ---------------------------------------------------------------------------
// Postgres (Supabase) — production mode
// ---------------------------------------------------------------------------
export async function postgresBackend(url: string): Promise<DbBackend> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    prepare: false, // required for Supabase transaction pooler
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idle_timeout: 20,
    types: {
      shgInt8: { to: OID.INT8, from: [OID.INT8], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      shgNumeric: { to: OID.NUMERIC, from: [OID.NUMERIC], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      shgDate: { to: OID.DATE, from: [OID.DATE], serialize: (x: string) => x, parse: (x: string) => x },
      shgTs: {
        to: OID.TIMESTAMPTZ,
        from: [OID.TIMESTAMP, OID.TIMESTAMPTZ],
        serialize: (x: string | Date) => (x instanceof Date ? x.toISOString() : x),
        parse: (x: string) => parseTimestamp(x),
      },
    },
  });
  return {
    kind: "postgres",
    transaction: async (fn) =>
      (await sql.begin(async (tx) => {
        const q: Queryable = {
          query: async <T,>(text: string, params?: unknown[]) =>
            (await tx.unsafe(text, (params ?? []) as never[])) as unknown as T[],
        };
        return fn(q);
      })) as Awaited<ReturnType<typeof fn>>,
  };
}
