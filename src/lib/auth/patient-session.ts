import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { sessionSecret } from "../env";

// Patients are not platform users. After Patient ID + PIN verification they
// get a short-lived signed cookie scoped to their own records only.

const COOKIE = "shg_patient";
const TTL = 60 * 60 * 2;

const sign = (p: string) => createHmac("sha256", `patient:${sessionSecret()}`).update(p).digest("base64url");

export async function setPatientSession(patientId: string) {
  const payload = Buffer.from(JSON.stringify({ pid: patientId, exp: Math.floor(Date.now() / 1000) + TTL })).toString("base64url");
  (await cookies()).set(COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TTL,
  });
}

export async function getPatientSession(): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const a = Buffer.from(sign(payload));
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { pid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { pid: string; exp: number };
    return exp > Date.now() / 1000 ? pid : null;
  } catch {
    return null;
  }
}

export async function clearPatientSession() {
  (await cookies()).delete(COOKIE);
}
