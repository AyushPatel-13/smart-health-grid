import "server-only";
import type { z } from "zod";
import { getCurrentUser, type AppUser } from "../auth/user";
import { toDbError, withSystem } from "../db";
import { todayIST } from "../dates";
import { evaluateAll } from "../engine/evaluate";
import { fail, type ActionResult } from "./result";

function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message.startsWith("validation.") || issue.message.includes(".") ? issue.message : "validation.invalid";
  }
  return out;
}

/**
 * Standard server-action pipeline: authenticate → validate (Zod) → run.
 * Database errors are mapped to stable codes; unexpected errors are logged
 * server-side without leaking details to the client.
 */
export async function runAction<S extends z.ZodType>(
  schema: S,
  input: unknown,
  fn: (user: AppUser, data: z.infer<S>) => Promise<ActionResult>,
): Promise<ActionResult> {
  const user = await getCurrentUser();
  if (!user) return fail("NOT_AUTHENTICATED");
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", fieldErrors(parsed.error));
  try {
    return await fn(user, parsed.data);
  } catch (err) {
    const e = toDbError(err);
    if (e.code === "UNKNOWN" || e.code === "INVALID_INPUT") console.error("[shg] action failed:", e.message);
    return fail(e.code);
  }
}

/** Re-run deterministic alert rules for the given facilities (trusted context). */
export async function refreshAlerts(facilityIds: string[]) {
  if (!facilityIds.length) return { created: 0, updated: 0, resolved: 0 };
  const today = todayIST();
  return withSystem((q) => evaluateAll(q, today));
}
