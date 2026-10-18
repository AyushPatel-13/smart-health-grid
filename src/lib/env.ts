// Runtime configuration. Values are read from the environment only on the
// server; nothing here is ever sent to the browser except `isSupabaseMode`.

export type DataMode = "demo" | "supabase";

export function getDataMode(): DataMode {
  const hasSupabase =
    !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
    !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    !!process.env.DATABASE_URL;
  if (process.env.SHG_DATA_MODE === "demo") return "demo";
  return hasSupabase ? "supabase" : "demo";
}

export function isDemoMode(): boolean {
  return getDataMode() === "demo";
}

export function sessionSecret(): string {
  const secret = process.env.SHG_SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  if (process.env.NODE_ENV === "production" && !process.env.SHG_ALLOW_INSECURE_DEMO_SECRET) {
    // A fixed fallback keeps the public demo usable, but warn loudly.
    console.warn("[shg] SHG_SESSION_SECRET is not set (>=32 chars). Using an insecure demo-only secret.");
  }
  return "shg-demo-only-insecure-session-secret-change-me";
}
