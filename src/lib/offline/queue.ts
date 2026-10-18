// Offline submission queue (browser only).
//
// When a submission fails because the device is OFFLINE (network error — not
// a validation or business error), it is stored locally with its idempotency
// key and replayed when connectivity returns. Every queued operation is
// idempotent on the server (registration key, request idempotency key,
// inventory idempotency key, one check-in per patient/day), so a replay can
// never create duplicate bookings, overbooking or double stock movements.
// Business conflicts on replay (e.g. insufficient stock) are NOT retried —
// they are surfaced to the user for review. Items expire after 24 h.

export type OfflineKind = "register" | "checkin" | "issue";

export interface OfflineItem {
  id: string;
  kind: OfflineKind;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  status: "queued" | "failed";
  error?: string;
}

const KEY = "shg_offline_queue_v1";
const TTL = 24 * 3600_000;
export const QUEUE_EVENT = "shg-offline-queue";

function read(): OfflineItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const items = raw ? (JSON.parse(raw) as OfflineItem[]) : [];
    return items.filter((i) => Date.now() - i.createdAt < TTL);
  } catch {
    return [];
  }
}

function write(items: OfflineItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage unavailable (private mode / quota): nothing we can persist.
  }
  window.dispatchEvent(new Event(QUEUE_EVENT));
}

export function listQueued(): OfflineItem[] {
  return read();
}

export function enqueue(kind: OfflineKind, payload: Record<string, unknown>): OfflineItem {
  const item: OfflineItem = { id: crypto.randomUUID(), kind, payload, createdAt: Date.now(), attempts: 0, status: "queued" };
  write([...read(), item]);
  return item;
}

export function removeQueued(id: string) {
  write(read().filter((i) => i.id !== id));
}

/** True when an error came from the network layer rather than the server. */
export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== "undefined" && !navigator.onLine) return true;
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /Failed to fetch|NetworkError|network|Load failed|fetch failed|TypeError/i.test(msg);
}

export type Handler = (payload: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; data?: unknown }>;

let flushing = false;

/** Replay queued items in order. Returns per-item outcomes for display. */
export async function flushQueue(handlers: Record<OfflineKind, Handler>) {
  if (flushing || (typeof navigator !== "undefined" && !navigator.onLine)) return [];
  flushing = true;
  const outcomes: { item: OfflineItem; ok: boolean; error?: string; data?: unknown }[] = [];
  try {
    for (const item of read().filter((i) => i.status === "queued")) {
      try {
        const res = await handlers[item.kind](item.payload);
        if (res.ok) {
          removeQueued(item.id);
          outcomes.push({ item, ok: true, data: res.data });
        } else {
          // Business/validation conflict: keep for user review, never auto-retry.
          write(read().map((i) => (i.id === item.id ? { ...i, status: "failed", error: res.error, attempts: i.attempts + 1 } : i)));
          outcomes.push({ item, ok: false, error: res.error });
        }
      } catch (err) {
        if (isNetworkError(err)) break; // still offline — try again later
        write(read().map((i) => (i.id === item.id ? { ...i, status: "failed", error: "UNKNOWN", attempts: i.attempts + 1 } : i)));
        outcomes.push({ item, ok: false, error: "UNKNOWN" });
      }
    }
  } finally {
    flushing = false;
  }
  return outcomes;
}
