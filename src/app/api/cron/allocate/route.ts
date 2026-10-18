import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runDueAllocations } from "@/lib/allocation/runner";

// Cron trigger for batch allocation (e.g. Vercel Cron, GitHub Actions, any
// scheduler). Requires `Authorization: Bearer <CRON_SECRET>`. Idempotent.

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const results = await runDueAllocations("cron");
  return NextResponse.json({ ok: true, results });
}
