export type Row = Record<string, unknown>;

/** Minimal query surface shared by the PGlite (demo) and Postgres (Supabase) backends. */
export interface Queryable {
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
}

export interface DbBackend {
  kind: "pglite" | "postgres";
  /** Run fn inside a single transaction (commit on success, rollback on throw). */
  transaction<R>(fn: (q: Queryable) => Promise<R>): Promise<R>;
}

/** Error raised by our SQL functions with a stable machine-readable code. */
export class DbError extends Error {
  constructor(
    public code: string,
    message: string,
    public pgCode?: string,
    public constraint?: string,
  ) {
    super(message);
    this.name = "DbError";
  }
}

const KNOWN_CODES = new Set([
  "NOT_AUTHENTICATED", "FORBIDDEN", "INVALID_QUANTITY", "BATCH_ALREADY_EXPIRED", "DUPLICATE_BATCH",
  "BATCH_NOT_FOUND", "BATCH_EXPIRED", "BATCH_NOT_EXPIRED", "REASON_REQUIRED", "INVALID_TXN_TYPE",
  "INVALID_TRANSITION", "INSUFFICIENT_STOCK", "TRANSFER_NOT_FOUND", "TRANSFER_NOT_PENDING", "TRANSFER_NOT_APPROVED",
  "DONOR_REQUIRED", "SAME_FACILITY", "DONOR_BELOW_SAFETY_STOCK", "ATTENDANCE_LOCKED", "BED_CAPACITY_EXCEEDED",
  "SHIFT_NOT_FOUND", "SHIFT_NOT_TODAY", "NOT_CHECKED_IN", "STAFF_NOT_FOUND", "STAFF_ON_LEAVE", "REASSIGNMENT_OVERLAP", "DONOR_MIN_STAFFING",
  "TRANSFER_NOT_DISPATCHED", "REPLENISHMENT_NOT_FOUND", "LEDGER_NOT_FOUND", "NO_SAFE_LENDER", "RECOMMENDATION_STALE",
  "PATIENT_NOT_FOUND", "APPOINTMENT_MISMATCH", "APPOINTMENT_NOT_TODAY", "APPOINTMENT_NOT_ACTIVE", "VISIT_NOT_FOUND",
]);

/** Normalise driver errors into DbError with an app-level code. */
export function toDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const e = err as { message?: string; code?: string; constraint?: string; constraint_name?: string };
  const message = e?.message ?? String(err);
  const pgCode = e?.code;
  const constraint = e?.constraint ?? e?.constraint_name;
  if (KNOWN_CODES.has(message)) return new DbError(message, message, pgCode, constraint);
  if (pgCode === "42501" || /row-level security|permission denied/i.test(message)) {
    return new DbError("FORBIDDEN", message, pgCode, constraint);
  }
  if (pgCode === "23505") return new DbError("DUPLICATE", message, pgCode, constraint);
  if (pgCode === "23514") return new DbError("CONSTRAINT", message, pgCode, constraint);
  if (pgCode === "23503") return new DbError("REFERENCE", message, pgCode, constraint);
  if (pgCode === "22P02" || pgCode === "22007" || pgCode === "22008") return new DbError("INVALID_INPUT", message, pgCode);
  return new DbError("UNKNOWN", message, pgCode, constraint);
}
