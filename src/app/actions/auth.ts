"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { verifyPassword } from "@/lib/auth/password";
import { createDemoSession, destroySession } from "@/lib/auth/session";
import { getDataMode } from "@/lib/env";
import { withSystem } from "@/lib/db";
import { LOCALE_COOKIE, normalizeLocale } from "@/lib/i18n";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { fail, type ActionResult } from "@/lib/actions/result";

const loginSchema = z.object({
  email: z.email().max(160),
  password: z.string().min(1).max(200),
});

// Basic in-memory brute-force throttle (per server instance).
const attempts = new Map<string, { n: number; first: number }>();
function throttled(key: string): boolean {
  const now = Date.now();
  const a = attempts.get(key);
  if (!a || now - a.first > 60_000) {
    attempts.set(key, { n: 1, first: now });
    return false;
  }
  a.n++;
  return a.n > 8;
}

export async function loginAction(input: unknown): Promise<ActionResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return fail("login.invalid");
  const { email, password } = parsed.data;
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (throttled(`${ip}:${email.toLowerCase()}`)) return fail("login.rateLimited");

  if (getDataMode() === "supabase") {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) return fail("login.invalid");
    const active = await withSystem((q) =>
      q.query<{ ok: boolean }>("select true as ok from public.profiles where id = $1 and is_active", [data.user.id]),
    );
    if (!active[0]) {
      await supabase.auth.signOut();
      return fail("login.invalid");
    }
  } else {
    const rows = await withSystem((q) =>
      q.query<{ id: string; encrypted_password: string | null }>(
        `select u.id, u.encrypted_password from auth.users u
           join public.profiles p on p.id = u.id and p.is_active
          where lower(u.email) = lower($1)`,
        [email],
      ),
    );
    const user = rows[0];
    // Always run a hash comparison to keep timing uniform.
    const valid = verifyPassword(password, user?.encrypted_password ?? "scrypt$00$00");
    if (!user || !valid) return fail("login.invalid");
    await createDemoSession(user.id);
  }
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

export async function setLocaleAction(locale: string): Promise<void> {
  const store = await cookies();
  store.set(LOCALE_COOKIE, normalizeLocale(locale), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
}
