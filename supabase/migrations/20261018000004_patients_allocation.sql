-- Smart Health Grid — patients, consent, services, hourly batch appointment
-- allocation, visits and queues.
--
-- Privacy: patient identity (patients, consent_records) is kept separate from
-- operational analytics. Analytics only ever consume aggregate counts
-- (patient_daily_stats). No Aadhaar number, image or biometric is stored.
-- Locations are stored rounded (~110 m) and only for allocation.

-- ---------------------------------------------------------------------------
-- Services offered by facilities
-- ---------------------------------------------------------------------------
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  name_hi text,
  category text not null,
  min_facility_type text not null default 'PHC' check (min_facility_type in ('PHC', 'CHC')),
  required_test_id uuid references public.diagnostic_tests (id) on delete set null,
  is_emergency boolean not null default false,
  avg_consult_minutes integer not null default 8 check (avg_consult_minutes between 1 and 120),
  created_at timestamptz not null default now()
);

create table if not exists public.facility_services (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (facility_id, service_id)
);

-- ---------------------------------------------------------------------------
-- Patients and consent (identity — separate from analytics)
-- ---------------------------------------------------------------------------
create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  patient_code text not null unique check (patient_code ~ '^SHG-[0-9A-Z]{8}$'),
  access_pin_hash text not null,
  full_name text not null check (length(full_name) between 2 and 120),
  birth_year integer check (birth_year between 1900 and 2100),
  sex text not null default 'undisclosed' check (sex in ('female', 'male', 'other', 'undisclosed')),
  phone text check (phone ~ '^[6-9][0-9]{9}$'),
  phone_verified boolean not null default false,
  address_text text check (length(address_text) <= 200),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  location_source text check (location_source in ('device', 'locality', 'staff')),
  district_id uuid references public.districts (id) on delete set null,
  preferred_language text not null default 'en' check (preferred_language in ('en', 'hi')),
  registered_via text not null default 'self' check (registered_via in ('self', 'assisted')),
  registered_by uuid references public.profiles (id) on delete set null,
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists patients_district_idx on public.patients (district_id);
drop trigger if exists patients_updated_at on public.patients;
create trigger patients_updated_at before update on public.patients
  for each row execute function public.set_updated_at();

create table if not exists public.consent_records (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients (id) on delete cascade,
  consent_type text not null check (consent_type in ('data_processing', 'location', 'sms_notifications')),
  granted boolean not null,
  notice_version text not null,
  recorded_at timestamptz not null default now(),
  withdrawn_at timestamptz
);
create index if not exists consent_patient_idx on public.consent_records (patient_id);

-- ---------------------------------------------------------------------------
-- Allocation windows (batches), slots, requests, appointments
-- ---------------------------------------------------------------------------
create table if not exists public.allocation_windows (
  id uuid primary key default gen_random_uuid(),
  window_start timestamptz not null unique,
  cutoff_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'processing', 'completed', 'failed')),
  attempts integer not null default 0,
  started_at timestamptz,
  processed_at timestamptz,
  last_error text,
  summary jsonb not null default '{}'::jsonb,
  triggered_by text,
  created_at timestamptz not null default now(),
  constraint cutoff_after_start check (cutoff_at > window_start)
);
create index if not exists allocation_windows_due_idx on public.allocation_windows (status, cutoff_at);

create table if not exists public.appointment_slots (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  slot_date date not null,
  start_time time not null,
  end_time time not null,
  capacity integer not null check (capacity between 0 and 500),
  allocated integer not null default 0 check (allocated >= 0),
  is_active boolean not null default true,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, service_id, slot_date, start_time),
  -- Overbooking is impossible at the database level.
  constraint no_overbooking check (allocated <= capacity),
  constraint slot_time_order check (end_time > start_time)
);
create index if not exists appointment_slots_key_idx on public.appointment_slots (service_id, slot_date, start_time);
drop trigger if exists appointment_slots_updated_at on public.appointment_slots;
create trigger appointment_slots_updated_at before update on public.appointment_slots
  for each row execute function public.set_updated_at();

create table if not exists public.appointment_requests (
  id uuid primary key default gen_random_uuid(),
  request_code text not null unique,
  patient_id uuid not null references public.patients (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete restrict,
  slot_date date not null,
  start_time time not null,
  preferred_facility_id uuid references public.health_centres (id) on delete set null,
  latitude double precision not null,
  longitude double precision not null,
  district_id uuid references public.districts (id) on delete set null,
  is_emergency boolean not null default false,
  window_id uuid references public.allocation_windows (id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'allocated', 'waitlisted', 'cancelled', 'emergency_referred')),
  tie_key text not null,
  idempotency_key text unique,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One active request per patient per service and time.
create unique index if not exists appointment_requests_active_idx
  on public.appointment_requests (patient_id, service_id, slot_date, start_time)
  where status in ('pending', 'allocated', 'waitlisted');
create index if not exists appointment_requests_window_idx on public.appointment_requests (window_id, status);
drop trigger if exists appointment_requests_updated_at on public.appointment_requests;
create trigger appointment_requests_updated_at before update on public.appointment_requests
  for each row execute function public.set_updated_at();

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  appointment_code text not null unique,
  request_id uuid not null unique references public.appointment_requests (id) on delete cascade,
  patient_id uuid not null references public.patients (id) on delete cascade,
  slot_id uuid not null references public.appointment_slots (id) on delete restrict,
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete restrict,
  slot_date date not null,
  start_time time not null,
  distance_km numeric(7, 2) not null,
  distance_method text not null default 'haversine_straight_line',
  preference_rank integer not null,
  rank_at_facility integer,
  window_id uuid references public.allocation_windows (id) on delete set null,
  status text not null default 'confirmed' check (status in ('confirmed', 'checked_in', 'completed', 'cancelled', 'no_show')),
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- No double booking: one active appointment per patient per time.
create unique index if not exists appointments_patient_time_idx
  on public.appointments (patient_id, slot_date, start_time) where status in ('confirmed', 'checked_in');
create index if not exists appointments_facility_date_idx on public.appointments (facility_id, slot_date);
drop trigger if exists appointments_updated_at on public.appointments;
create trigger appointments_updated_at before update on public.appointments
  for each row execute function public.set_updated_at();

create table if not exists public.allocation_decisions (
  id bigint generated always as identity primary key,
  window_id uuid references public.allocation_windows (id) on delete cascade,
  request_id uuid not null references public.appointment_requests (id) on delete cascade,
  facility_id uuid references public.health_centres (id) on delete cascade,
  slot_id uuid references public.appointment_slots (id) on delete set null,
  distance_km numeric(7, 2),
  preference_rank integer,
  rank_at_facility integer,
  outcome text not null check (outcome in ('allocated', 'rejected_capacity', 'ineligible', 'waitlisted', 'emergency', 'reallocated', 'cancelled')),
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists allocation_decisions_window_idx on public.allocation_decisions (window_id, request_id);

create table if not exists public.patient_notifications (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients (id) on delete cascade,
  request_id uuid references public.appointment_requests (id) on delete cascade,
  appointment_id uuid references public.appointments (id) on delete cascade,
  kind text not null check (kind in ('registered', 'pending', 'allocated', 'waitlisted', 'cancelled', 'reallocated', 'emergency')),
  params jsonb not null default '{}'::jsonb,
  channel text not null default 'in_app' check (channel in ('in_app', 'sms')),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists patient_notifications_patient_idx on public.patient_notifications (patient_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Visits and queues (actual footfall)
-- ---------------------------------------------------------------------------
create table if not exists public.queue_counters (
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  visit_date date not null,
  last_number integer not null default 0,
  primary key (facility_id, visit_date)
);

create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  visit_code text not null unique,
  patient_id uuid not null references public.patients (id) on delete cascade,
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  service_id uuid references public.services (id) on delete set null,
  appointment_id uuid unique references public.appointments (id) on delete set null,
  visit_date date not null,
  queue_number integer not null,
  status text not null default 'waiting'
    check (status in ('waiting', 'in_consultation', 'completed', 'cancelled', 'left_without_care')),
  checked_in_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  checked_in_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, visit_date, queue_number)
);
-- One active check-in per patient per facility per day (no inflated footfall).
create unique index if not exists visits_one_active_idx
  on public.visits (patient_id, facility_id, visit_date) where status <> 'cancelled';
create index if not exists visits_facility_date_idx on public.visits (facility_id, visit_date, status);
drop trigger if exists visits_updated_at on public.visits;
create trigger visits_updated_at before update on public.visits
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.services enable row level security;
alter table public.facility_services enable row level security;
alter table public.patients enable row level security;
alter table public.consent_records enable row level security;
alter table public.allocation_windows enable row level security;
alter table public.appointment_slots enable row level security;
alter table public.appointment_requests enable row level security;
alter table public.appointments enable row level security;
alter table public.allocation_decisions enable row level security;
alter table public.patient_notifications enable row level security;
alter table public.queue_counters enable row level security;
alter table public.visits enable row level security;

grant select on public.services, public.facility_services, public.patients, public.consent_records,
  public.allocation_windows, public.appointment_slots, public.appointment_requests, public.appointments,
  public.allocation_decisions, public.patient_notifications, public.visits to authenticated;
grant insert, update on public.appointment_slots, public.facility_services to authenticated;
revoke insert, update, delete on public.patients, public.consent_records, public.visits, public.queue_counters,
  public.appointments, public.appointment_requests from authenticated;

create policy services_select on public.services for select to authenticated using (true);
create policy facility_services_select on public.facility_services for select to authenticated using (true);
create policy facility_services_write on public.facility_services for insert to authenticated
  with check (public.can_admin_facility(facility_id));
create policy facility_services_update on public.facility_services for update to authenticated
  using (public.can_admin_facility(facility_id)) with check (public.can_admin_facility(facility_id));

-- Patient identity: admins of the patient's district, or staff of a facility
-- where the patient has an appointment or visit. Read-only officials: none.
create or replace function public.can_read_patient(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.patients p
    where p.id = pid and (
      (public.current_app_role() = 'district_admin'
        and (public.current_district_id() is null or p.district_id = public.current_district_id()))
      or exists (select 1 from public.appointments a where a.patient_id = pid and public.can_write_facility(a.facility_id))
      or exists (select 1 from public.visits v where v.patient_id = pid and public.can_write_facility(v.facility_id))
    )
  )
$$;

create policy patients_select on public.patients for select to authenticated using (public.can_read_patient(id));
create policy consent_select on public.consent_records for select to authenticated using (public.can_read_patient(patient_id));
create policy notifications_select on public.patient_notifications for select to authenticated using (public.can_read_patient(patient_id));

create policy windows_select on public.allocation_windows for select to authenticated using (true);

create policy slots_select on public.appointment_slots for select to authenticated using (public.can_read_facility(facility_id));
create policy slots_insert on public.appointment_slots for insert to authenticated with check (public.can_write_facility(facility_id));
create policy slots_update on public.appointment_slots for update to authenticated
  using (public.can_write_facility(facility_id)) with check (public.can_write_facility(facility_id));

create policy requests_select on public.appointment_requests for select to authenticated using (
  (public.current_app_role() = 'district_admin' and (public.current_district_id() is null or district_id = public.current_district_id()))
  or exists (select 1 from public.appointments a where a.request_id = appointment_requests.id and public.can_read_facility(a.facility_id))
);
create policy appointments_select on public.appointments for select to authenticated using (public.can_read_facility(facility_id));
create policy decisions_select on public.allocation_decisions for select to authenticated using (
  public.current_app_role() = 'district_admin'
  and (facility_id is null or public.can_read_facility(facility_id))
);
create policy visits_select on public.visits for select to authenticated using (public.can_read_facility(facility_id));

-- ---------------------------------------------------------------------------
-- Check-in: creates a visit, assigns a queue number and increments the
-- facility's daily footfall exactly once. Idempotent per patient/facility/day.
-- ---------------------------------------------------------------------------
create or replace function public.check_in_patient(
  p_facility_id uuid,
  p_patient_code text,
  p_appointment_id uuid,
  p_service_id uuid
) returns table (visit_id uuid, visit_code text, queue_number integer, duplicate boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_patient uuid;
  v_today date := current_date;
  v_existing record;
  v_appt record;
  v_q integer;
  v_id uuid;
  v_code text;
  v_service uuid := p_service_id;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not public.can_write_facility(p_facility_id) then raise exception 'FORBIDDEN'; end if;
  select id into v_patient from public.patients where patient_code = upper(trim(p_patient_code));
  if v_patient is null then raise exception 'PATIENT_NOT_FOUND'; end if;

  if p_appointment_id is not null then
    select * into v_appt from public.appointments where id = p_appointment_id for update;
    if not found or v_appt.patient_id <> v_patient or v_appt.facility_id <> p_facility_id then raise exception 'APPOINTMENT_MISMATCH'; end if;
    if v_appt.slot_date <> v_today then raise exception 'APPOINTMENT_NOT_TODAY'; end if;
    if v_appt.status not in ('confirmed', 'checked_in') then raise exception 'APPOINTMENT_NOT_ACTIVE'; end if;
    v_service := v_appt.service_id;
  end if;

  -- Serialise check-ins for this facility/day (also guards the queue counter).
  insert into public.queue_counters (facility_id, visit_date, last_number) values (p_facility_id, v_today, 0)
  on conflict (facility_id, visit_date) do nothing;
  perform 1 from public.queue_counters where facility_id = p_facility_id and visit_date = v_today for update;

  select v.id, v.visit_code, v.queue_number into v_existing from public.visits v
   where v.patient_id = v_patient and v.facility_id = p_facility_id and v.visit_date = v_today and v.status <> 'cancelled';
  if found then
    return query select v_existing.id, v_existing.visit_code, v_existing.queue_number, true;
    return;
  end if;

  update public.queue_counters set last_number = last_number + 1
   where facility_id = p_facility_id and visit_date = v_today returning last_number into v_q;
  v_code := 'V-' || to_char(v_today, 'YYYYMMDD') || '-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
  insert into public.visits (visit_code, patient_id, facility_id, service_id, appointment_id, visit_date, queue_number, checked_in_by)
  values (v_code, v_patient, p_facility_id, v_service, p_appointment_id, v_today, v_q, auth.uid())
  returning id into v_id;

  if p_appointment_id is not null then
    update public.appointments set status = 'checked_in' where id = p_appointment_id;
  end if;

  -- Actual footfall: aggregate only (no patient identifiers in analytics).
  insert into public.patient_daily_stats (facility_id, stat_date, opd_visits, recorded_by, notes)
  values (p_facility_id, v_today, 1, auth.uid(), 'Auto-counted from check-ins')
  on conflict (facility_id, stat_date) do update set opd_visits = public.patient_daily_stats.opd_visits + 1;

  perform public.write_audit('visit.checked_in', 'visit', v_id::text, p_facility_id,
    jsonb_build_object('queue_number', v_q, 'appointment_id', p_appointment_id));
  return query select v_id, v_code, v_q, false;
end $$;

create or replace function public.update_visit_status(p_visit_id uuid, p_status text, p_reason text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v record;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v from public.visits where id = p_visit_id for update;
  if not found then raise exception 'VISIT_NOT_FOUND'; end if;
  if not public.can_write_facility(v.facility_id) then raise exception 'FORBIDDEN'; end if;
  if v.status in ('completed', 'cancelled', 'left_without_care') then raise exception 'INVALID_TRANSITION'; end if;
  if p_status not in ('in_consultation', 'completed', 'cancelled', 'left_without_care') then raise exception 'INVALID_TRANSITION'; end if;
  if p_status = 'cancelled' and length(coalesce(trim(p_reason), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;

  update public.visits set status = p_status,
    started_at = case when p_status = 'in_consultation' then now() else started_at end,
    completed_at = case when p_status in ('completed', 'left_without_care') then now() else completed_at end,
    cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
    cancel_reason = case when p_status = 'cancelled' then trim(p_reason) else cancel_reason end
  where id = p_visit_id;

  if p_status = 'cancelled' then
    -- A cancelled (mistaken) check-in must not inflate footfall.
    update public.patient_daily_stats set opd_visits = greatest(0, opd_visits - 1)
     where facility_id = v.facility_id and stat_date = v.visit_date;
    if v.appointment_id is not null then
      update public.appointments set status = 'confirmed' where id = v.appointment_id and status = 'checked_in';
    end if;
  elsif p_status = 'completed' and v.appointment_id is not null then
    update public.appointments set status = 'completed' where id = v.appointment_id;
  end if;

  perform public.write_audit('visit.' || p_status, 'visit', p_visit_id::text, v.facility_id, jsonb_build_object('reason', p_reason));
  return p_status;
end $$;

grant execute on function public.check_in_patient(uuid, text, uuid, uuid), public.update_visit_status(uuid, text, text) to authenticated;
