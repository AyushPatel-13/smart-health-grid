-- Smart Health Grid — live operations: idempotent (offline-safe) patient
-- registration, overload warnings and consultation timing for wait estimates.

-- A client-generated key makes registration retry-safe: replaying the same
-- submission (e.g. after an offline queue sync) returns the same patient.
alter table public.patients add column if not exists registration_key text unique;

alter table public.alerts drop constraint if exists alerts_category_check;
alter table public.alerts add constraint alerts_category_check check (category in (
  'stock_out', 'stock_risk', 'low_stock', 'expired_stock', 'near_expiry', 'bed_capacity', 'staffing_gap',
  'diagnostic_unavailable', 'diagnostic_stale', 'footfall_spike', 'stale_data', 'manual',
  'restoration_overdue', 'replenishment_failed', 'workload_staffing', 'attendance_review', 'overload_risk'));

create index if not exists visits_completed_idx on public.visits (facility_id, visit_date) where status = 'completed';
create index if not exists appointment_requests_created_idx on public.appointment_requests (created_at);
