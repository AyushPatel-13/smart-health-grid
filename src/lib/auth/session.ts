import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getDataMode, sessionSecret } from "../env";
import { createSupabaseServerClient } from "../supabase/server";

export const DEMO_SESSION_COOKIE = "shg_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

function encode(uid: string, exp: number): string {
  const payload = Buffer.from(JSON.stringify({ uid, exp })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function decode(token: string | undefined): string | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { uid: string; exp: number };
    if (typeof uid !== "string" || typeof exp !== "number" || exp < Date.now() / 1000) return null;
    return uid;
  } catch {
    return null;
  }
}

/** Authenticated user id for this request, or null. Never trusts client-sent ids. */
export async function getSessionUserId(): Promise<string | null> {
  if (getDataMode() === "supabase") {
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  }
  const store = await cookies();
  return decode(store.get(DEMO_SESSION_COOKIE)?.value);
}

export async function createDemoSession(uid: string): Promise<void> {
  const store = await cookies();
  store.set(DEMO_SESSION_COOKIE, encode(uid, Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  if (getDataMode() === "supabase") {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.signOut();
    return;
  }
  const store = await cookies();
  store.delete(DEMO_SESSION_COOKIE);
}
