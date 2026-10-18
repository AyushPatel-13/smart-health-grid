-- Smart Health Grid — core schema
-- Normalised operational data for PHC/CHC resource monitoring.
-- No patient-identifiable information is stored anywhere in this schema:
-- footfall is captured only as aggregate daily counts.

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.app_role as enum ('district_admin', 'facility_staff', 'read_only');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Geography and facilities
-- ---------------------------------------------------------------------------
create table if not exists public.districts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  name_hi text,
  state text not null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.health_centres (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9-]{3,32}$'),
  name text not null check (length(name) between 3 and 120),
  name_hi text,
  facility_type text not null check (facility_type in ('PHC', 'CHC')),
  district_id uuid not null references public.districts (id) on delete restrict,
  block text,
  address text,
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  bed_capacity integer not null default 0 check (bed_capacity between 0 and 1000),
  opd_capacity_per_day integer not null default 100 check (opd_capacity_per_day between 1 and 5000),
  operational_status text not null default 'operational'
    check (operational_status in ('operational', 'limited', 'non_operational')),
  is_demo boolean not null default false,
  last_data_update timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists health_centres_district_idx on public.health_centres (district_id);
drop trigger if exists health_centres_updated_at on public.health_centres;
create trigger health_centres_updated_at before update on public.health_centres
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Users and roles (1:1 with auth.users)
-- district_id NULL on an admin/read-only profile means state-level scope.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null check (length(full_name) between 2 and 120),
  role public.app_role not null default 'read_only',
  district_id uuid references public.districts (id) on delete set null,
  facility_id uuid references public.health_centres (id) on delete set null,
  is_active boolean not null default true,
  preferred_language text not null default 'en' check (preferred_language in ('en', 'hi')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_requires_facility check (role <> 'facility_staff' or facility_id is not null)
);
create index if not exists profiles_district_idx on public.profiles (district_id);
create index if not exists profiles_facility_idx on public.profiles (facility_id);
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Medicines and inventory
-- ---------------------------------------------------------------------------
create table if not exists public.medicines (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9-]{3,32}$'),
  name text not null,
  name_hi text,
  unit text not null check (unit in ('tablet', 'capsule', 'sachet', 'vial', 'ampoule', 'bottle', 'inhaler', 'tube', 'strip', 'unit')),
  category text not null,
  is_essential boolean not null default true,
  created_at timestamptz not null default now()
);

-- Per-facility stock rules for a medicine.
create table if not exists public.facility_medicines (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  medicine_id uuid not null references public.medicines (id) on delete restrict,
  min_safety_stock integer not null default 0 check (min_safety_stock >= 0),
  lead_time_days integer not null default 7 check (lead_time_days between 0 and 180),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, medicine_id)
);
drop trigger if exists facility_medicines_updated_at on public.facility_medicines;
create trigger facility_medicines_updated_at before update on public.facility_medicines
  for each row execute function public.set_updated_at();

create table if not exists public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  medicine_id uuid not null references public.medicines (id) on delete restrict,
  batch_number text not null check (batch_number ~ '^[A-Za-z0-9/_-]{2,40}$'),
  quantity_received integer not null check (quantity_received > 0),
  quantity_available integer not null check (quantity_available >= 0),
  expiry_date date not null,
  supplier text,
  source text not null default 'state_supply'
    check (source in ('state_supply', 'district_warehouse', 'local_purchase', 'transfer', 'donation', 'other')),
  received_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, medicine_id, batch_number)
);
create index if not exists inventory_batches_fac_med_idx on public.inventory_batches (facility_id, medicine_id);
create index if not exists inventory_batches_expiry_idx on public.inventory_batches (expiry_date);
drop trigger if exists inventory_batches_updated_at on public.inventory_batches;
create trigger inventory_batches_updated_at before update on public.inventory_batches
  for each row execute function public.set_updated_at();

-- Append-only stock ledger. quantity is signed (+ in, - out).
create table if not exists public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  medicine_id uuid not null references public.medicines (id) on delete restrict,
  batch_id uuid not null references public.inventory_batches (id) on delete cascade,
  txn_type text not null
    check (txn_type in ('receipt', 'issue', 'adjustment', 'transfer_in', 'transfer_out', 'expiry_writeoff')),
  quantity integer not null check (quantity <> 0),
  balance_after integer not null check (balance_after >= 0),
  reason text,
  reference_type text,
  reference_id uuid,
  idempotency_key text unique,
  performed_by uuid references public.profiles (id) on delete set null,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint txn_direction check (
    (txn_type in ('receipt', 'transfer_in') and quantity > 0)
    or (txn_type in ('issue', 'transfer_out', 'expiry_writeoff') and quantity < 0)
    or txn_type = 'adjustment'
  ),
  constraint adjustment_reason check (txn_type <> 'adjustment' or length(coalesce(reason, '')) >= 5)
);
create index if not exists inventory_txn_fac_med_time_idx
  on public.inventory_transactions (facility_id, medicine_id, occurred_at);
create index if not exists inventory_txn_batch_idx on public.inventory_transactions (batch_id);
create index if not exists inventory_txn_time_idx on public.inventory_transactions (occurred_at desc);

create table if not exists public.expected_deliveries (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  medicine_id uuid not null references public.medicines (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  expected_date date not null,
  source text,
  status text not null default 'pending' check (status in ('pending', 'received', 'cancelled')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists expected_deliveries_fac_idx on public.expected_deliveries (facility_id, medicine_id, status);

-- ---------------------------------------------------------------------------
-- Patient footfall (aggregate counts only — no patient identifiers)
-- ---------------------------------------------------------------------------
create table if not exists public.patient_daily_stats (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  stat_date date not null,
  opd_visits integer not null check (opd_visits between 0 and 20000),
  ipd_admissions integer not null default 0 check (ipd_admissions between 0 and 2000),
  emergency_visits integer not null default 0 check (emergency_visits between 0 and 5000),
  notes text,
  revision integer not null default 1 check (revision >= 1),
  correction_reason text,
  recorded_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, stat_date),
  constraint correction_needs_reason check (revision = 1 or length(coalesce(correction_reason, '')) >= 5)
);
create index if not exists patient_stats_date_idx on public.patient_daily_stats (stat_date);
drop trigger if exists patient_stats_updated_at on public.patient_daily_stats;
create trigger patient_stats_updated_at before update on public.patient_daily_stats
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Beds (per ward)
-- ---------------------------------------------------------------------------
create table if not exists public.bed_status (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  ward text not null check (length(ward) between 2 and 60),
  total_beds integer not null check (total_beds between 0 and 1000),
  occupied_beds integer not null check (occupied_beds >= 0),
  out_of_service_beds integer not null default 0 check (out_of_service_beds >= 0),
  updated_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, ward),
  constraint occupancy_within_capacity check (occupied_beds + out_of_service_beds <= total_beds)
);
drop trigger if exists bed_status_updated_at on public.bed_status;
create trigger bed_status_updated_at before update on public.bed_status
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Staff, rosters and attendance
-- ---------------------------------------------------------------------------
create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  employee_code text not null unique,
  full_name text not null,
  designation text not null
    check (designation in ('medical_officer', 'specialist', 'staff_nurse', 'pharmacist', 'lab_technician', 'anm', 'other')),
  is_doctor boolean generated always as (designation in ('medical_officer', 'specialist')) stored,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists staff_facility_idx on public.staff (facility_id);
drop trigger if exists staff_updated_at on public.staff;
create trigger staff_updated_at before update on public.staff
  for each row execute function public.set_updated_at();

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  staff_id uuid not null references public.staff (id) on delete cascade,
  shift_date date not null,
  shift_type text not null check (shift_type in ('morning', 'evening', 'night', 'on_call')),
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (staff_id, shift_date, shift_type)
);
create index if not exists shifts_fac_date_idx on public.shifts (facility_id, shift_date);

-- A shift with no attendance row is an INCOMPLETE record, never an absence.
create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null unique references public.shifts (id) on delete cascade,
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  status text not null check (status in ('present', 'absent', 'approved_leave')),
  verification_status text not null default 'unverified' check (verification_status in ('verified', 'unverified')),
  notes text,
  recorded_by uuid references public.profiles (id) on delete set null,
  recorded_at timestamptz not null default now(),
  verified_by uuid references public.profiles (id) on delete set null,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint verified_has_time check (verification_status = 'unverified' or verified_at is not null)
);
create index if not exists attendance_fac_idx on public.attendance (facility_id);
drop trigger if exists attendance_updated_at on public.attendance;
create trigger attendance_updated_at before update on public.attendance
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Diagnostics
-- ---------------------------------------------------------------------------
create table if not exists public.diagnostic_tests (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  name_hi text,
  category text not null,
  is_essential boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.diagnostic_services (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  test_id uuid not null references public.diagnostic_tests (id) on delete restrict,
  status text not null check (status in ('available', 'limited', 'unavailable')),
  restriction_note text,
  unavailability_reason text,
  equipment_issue text,
  required_supplies text,
  estimated_restoration_date date,
  last_verified_at timestamptz,
  updated_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, test_id),
  constraint unavailable_needs_reason check (
    status = 'available' or length(coalesce(unavailability_reason, restriction_note, '')) >= 3
  )
);
drop trigger if exists diagnostic_services_updated_at on public.diagnostic_services;
create trigger diagnostic_services_updated_at before update on public.diagnostic_services
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Alerts and intervention tracking
-- ---------------------------------------------------------------------------
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  category text not null check (category in (
    'stock_out', 'stock_risk', 'low_stock', 'expired_stock', 'near_expiry', 'bed_capacity',
    'staffing_gap', 'diagnostic_unavailable', 'diagnostic_stale', 'footfall_spike', 'stale_data', 'manual')),
  severity text not null check (severity in ('critical', 'warning', 'info')),
  resource_type text,
  resource_id uuid,
  resource_label text,
  title text not null,
  explanation text not null,
  supporting_values jsonb not null default '{}'::jsonb,
  recommended_action text,
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  source text not null default 'rule' check (source in ('rule', 'manual')),
  dedupe_key text,
  assigned_to uuid references public.profiles (id) on delete set null,
  created_by uuid references public.profiles (id) on delete set null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  resolution_notes text,
  last_evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint resolved_consistency check (status <> 'resolved' or resolved_at is not null)
);
-- At most one active alert per underlying issue.
create unique index if not exists alerts_active_dedupe_idx
  on public.alerts (dedupe_key) where status <> 'resolved' and dedupe_key is not null;
create index if not exists alerts_fac_status_idx on public.alerts (facility_id, status);
create index if not exists alerts_created_idx on public.alerts (created_at desc);
drop trigger if exists alerts_updated_at on public.alerts;
create trigger alerts_updated_at before update on public.alerts
  for each row execute function public.set_updated_at();

create table if not exists public.alert_events (
  id bigint generated always as identity primary key,
  alert_id uuid not null references public.alerts (id) on delete cascade,
  event_type text not null check (event_type in (
    'created', 'updated', 'assigned', 'acknowledged', 'resolved', 'reopened', 'auto_resolved', 'comment')),
  actor_id uuid references public.profiles (id) on delete set null,
  notes text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists alert_events_alert_idx on public.alert_events (alert_id, created_at);

-- ---------------------------------------------------------------------------
-- Forecast snapshots
-- ---------------------------------------------------------------------------
create table if not exists public.forecasts (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  medicine_id uuid references public.medicines (id) on delete cascade,
  forecast_type text not null check (forecast_type in ('footfall', 'medicine_demand')),
  method text not null,
  horizon_days integer not null check (horizon_days between 1 and 90),
  history_points integer not null check (history_points >= 0),
  data_sufficiency text not null check (data_sufficiency in ('sufficient', 'limited', 'insufficient')),
  forecast_start date not null,
  forecast_values jsonb not null default '[]'::jsonb,
  backtest jsonb,
  limitations jsonb not null default '[]'::jsonb,
  generated_by uuid references public.profiles (id) on delete set null,
  generated_at timestamptz not null default now()
);
create index if not exists forecasts_lookup_idx on public.forecasts (facility_id, forecast_type, generated_at desc);

-- ---------------------------------------------------------------------------
-- Transfer requests (redistribution)
-- ---------------------------------------------------------------------------
create table if not exists public.transfer_requests (
  id uuid primary key default gen_random_uuid(),
  request_code text not null unique,
  medicine_id uuid not null references public.medicines (id) on delete restrict,
  -- NULL while a staff-raised request awaits a donor chosen by the district admin
  from_facility_id uuid references public.health_centres (id) on delete restrict,
  to_facility_id uuid not null references public.health_centres (id) on delete restrict,
  quantity integer not null check (quantity > 0),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'completed', 'cancelled')),
  origin text not null default 'manual' check (origin in ('recommendation', 'manual')),
  justification text not null check (length(justification) >= 5),
  calculation jsonb not null default '{}'::jsonb,
  estimated_transit_hours numeric(6, 1),
  requested_by uuid references public.profiles (id) on delete set null,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  completed_by uuid references public.profiles (id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint different_facilities check (from_facility_id <> to_facility_id)
);
-- Prevent duplicate in-flight transfers for the same route and medicine.
create unique index if not exists transfer_requests_active_idx
  on public.transfer_requests (medicine_id, from_facility_id, to_facility_id)
  where status in ('pending', 'approved');
create unique index if not exists transfer_requests_active_open_idx
  on public.transfer_requests (medicine_id, to_facility_id)
  where status in ('pending', 'approved') and from_facility_id is null;
create index if not exists transfer_requests_status_idx on public.transfer_requests (status, created_at desc);
drop trigger if exists transfer_requests_updated_at on public.transfer_requests;
create trigger transfer_requests_updated_at before update on public.transfer_requests
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles (id) on delete set null,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id text,
  facility_id uuid references public.health_centres (id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_facility_idx on public.audit_logs (facility_id, created_at desc);
