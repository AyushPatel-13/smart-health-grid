-- Smart Health Grid — doctor directory, demand-based redeployment and
-- verified mobile attendance.
--
-- Privacy: attendance stores only the computed distance to the facility and
-- the reported GPS accuracy — never raw coordinates, never continuous
-- tracking, and no biometric data. Failed verification sends a record to
-- manual review; it never marks a doctor absent.

alter table public.staff
  add column if not exists qualification text,
  add column if not exists registration_number text,
  add column if not exists registration_verified boolean not null default false,
  add column if not exists profile_id uuid unique references public.profiles (id) on delete set null;

create table if not exists public.staff_services (
  staff_id uuid not null references public.staff (id) on delete cascade,
  service_id uuid not null references public.services (id) on delete cascade,
  primary key (staff_id, service_id)
);

alter table public.health_centres
  add column if not exists geofence_radius_m integer not null default 250 check (geofence_radius_m between 50 and 5000);

alter table public.shifts
  add column if not exists original_facility_id uuid references public.health_centres (id) on delete set null,
  add column if not exists reassignment_id uuid;

alter table public.attendance
  add column if not exists check_in_at timestamptz,
  add column if not exists check_out_at timestamptz,
  add column if not exists method text not null default 'manual' check (method in ('manual', 'mobile_geofence', 'mobile_geofence_simulated')),
  add column if not exists check_in_distance_m integer,
  add column if not exists check_in_accuracy_m integer,
  add column if not exists identity_method text,
  add column if not exists review_status text not null default 'none' check (review_status in ('none', 'needs_review', 'reviewed')),
  add column if not exists review_reasons jsonb not null default '[]'::jsonb,
  add column if not exists duty_minutes integer check (duty_minutes >= 0);
create index if not exists attendance_review_idx on public.attendance (review_status) where review_status = 'needs_review';

create table if not exists public.attendance_events (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts (id) on delete cascade,
  staff_id uuid not null references public.staff (id) on delete cascade,
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  event_type text not null check (event_type in ('check_in', 'check_out')),
  nonce text not null unique,
  server_time timestamptz not null default now(),
  client_position_time timestamptz,
  distance_m integer,
  accuracy_m integer,
  location_age_s integer,
  identity_method text,
  result text not null check (result in ('accepted', 'needs_review', 'duplicate')),
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists attendance_events_shift_idx on public.attendance_events (shift_id);

create table if not exists public.staff_reassignments (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  staff_id uuid not null references public.staff (id) on delete cascade,
  from_facility_id uuid not null references public.health_centres (id) on delete cascade,
  to_facility_id uuid not null references public.health_centres (id) on delete cascade,
  start_date date not null,
  end_date date not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'completed', 'cancelled')),
  reason text not null check (length(reason) >= 5),
  recommendation jsonb not null default '{}'::jsonb,
  requested_by uuid references public.profiles (id) on delete set null,
  reviewed_by uuid references public.profiles (id) on delete set null,
  reviewed_at timestamptz,
  review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reassignment_dates check (end_date >= start_date and end_date - start_date <= 30),
  constraint reassignment_facilities check (from_facility_id <> to_facility_id)
);
create unique index if not exists staff_reassignments_pending_idx
  on public.staff_reassignments (staff_id, start_date) where status in ('pending', 'approved');
drop trigger if exists staff_reassignments_updated_at on public.staff_reassignments;
create trigger staff_reassignments_updated_at before update on public.staff_reassignments
  for each row execute function public.set_updated_at();

alter table public.staff_services enable row level security;
alter table public.attendance_events enable row level security;
alter table public.staff_reassignments enable row level security;
grant select on public.staff_services, public.attendance_events, public.staff_reassignments to authenticated;
revoke insert, update, delete on public.attendance_events, public.staff_reassignments from authenticated;
create policy staff_services_select on public.staff_services for select to authenticated using (
  exists (select 1 from public.staff s where s.id = staff_id and public.can_read_facility(s.facility_id)));
create policy attendance_events_select on public.attendance_events for select to authenticated using (public.can_read_facility(facility_id));
create policy reassignments_select on public.staff_reassignments for select to authenticated using (
  public.can_read_facility(from_facility_id) or public.can_read_facility(to_facility_id));

-- Allow trusted, fully verified mobile check-ins to be recorded as verified.
create or replace function public.enforce_attendance_rules() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or current_setting('shg.trusted_attendance', true) = 'on' then return new; end if;
  if tg_op = 'UPDATE' and old.verification_status = 'verified' and not public.is_district_admin() then
    raise exception 'ATTENDANCE_LOCKED';
  end if;
  if new.verification_status = 'verified' and (tg_op = 'INSERT' or old.verification_status <> 'verified') then
    if not public.is_district_admin() then raise exception 'FORBIDDEN'; end if;
    new.verified_by := auth.uid();
    new.verified_at := now();
  end if;
  if new.verification_status = 'unverified' then
    new.verified_by := null;
    new.verified_at := null;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Mobile check-in / check-out. The server action computes distance and runs
-- the verification rules; this function enforces identity of the caller,
-- shift date, replay protection (unique nonce), duplicate check-ins and uses
-- the SERVER timestamp.
-- ---------------------------------------------------------------------------
create or replace function public.record_mobile_attendance(
  p_shift_id uuid, p_event text, p_nonce text, p_result text, p_reasons jsonb,
  p_distance_m integer, p_accuracy_m integer, p_location_age_s integer, p_position_time timestamptz,
  p_identity_method text, p_simulated boolean, p_duty_minutes integer
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_shift record;
  v_att public.attendance%rowtype;
  v_prev text;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select s.*, st.profile_id into v_shift from public.shifts s join public.staff st on st.id = s.staff_id where s.id = p_shift_id;
  if not found then raise exception 'SHIFT_NOT_FOUND'; end if;
  if v_shift.profile_id is distinct from auth.uid() then raise exception 'FORBIDDEN'; end if;
  if v_shift.shift_date <> current_date then raise exception 'SHIFT_NOT_TODAY'; end if;
  if p_event not in ('check_in', 'check_out') or p_result not in ('accepted', 'needs_review') then raise exception 'INVALID_INPUT'; end if;

  -- Replay protection: the same nonce returns the original outcome.
  select result into v_prev from public.attendance_events where nonce = p_nonce;
  if found then return 'duplicate:' || v_prev; end if;

  select * into v_att from public.attendance where shift_id = p_shift_id for update;

  if p_event = 'check_in' then
    if found and v_att.check_in_at is not null then
      insert into public.attendance_events (shift_id, staff_id, facility_id, event_type, nonce, result, reasons)
      values (p_shift_id, v_shift.staff_id, v_shift.facility_id, 'check_in', p_nonce, 'duplicate', '["already_checked_in"]'::jsonb);
      return 'already_checked_in';
    end if;
    perform set_config('shg.trusted_attendance', case when p_result = 'accepted' then 'on' else 'off' end, true);
    insert into public.attendance (shift_id, facility_id, status, verification_status, recorded_by, recorded_at, verified_at,
                                   check_in_at, method, check_in_distance_m, check_in_accuracy_m, identity_method, review_status, review_reasons)
    values (p_shift_id, v_shift.facility_id, 'present', case when p_result = 'accepted' then 'verified' else 'unverified' end,
            auth.uid(), now(), case when p_result = 'accepted' then now() end, now(),
            case when p_simulated then 'mobile_geofence_simulated' else 'mobile_geofence' end, p_distance_m, p_accuracy_m,
            p_identity_method, case when p_result = 'accepted' then 'none' else 'needs_review' end, coalesce(p_reasons, '[]'::jsonb))
    on conflict (shift_id) do update set
      status = 'present', check_in_at = now(), method = excluded.method, check_in_distance_m = excluded.check_in_distance_m,
      check_in_accuracy_m = excluded.check_in_accuracy_m, identity_method = excluded.identity_method,
      verification_status = excluded.verification_status, verified_at = excluded.verified_at,
      review_status = excluded.review_status, review_reasons = excluded.review_reasons, recorded_by = auth.uid(), recorded_at = now();
    perform set_config('shg.trusted_attendance', 'off', true);
  else
    if not found or v_att.check_in_at is null then raise exception 'NOT_CHECKED_IN'; end if;
    if v_att.check_out_at is not null then
      insert into public.attendance_events (shift_id, staff_id, facility_id, event_type, nonce, result, reasons)
      values (p_shift_id, v_shift.staff_id, v_shift.facility_id, 'check_out', p_nonce, 'duplicate', '["already_checked_out"]'::jsonb);
      return 'already_checked_out';
    end if;
    perform set_config('shg.trusted_attendance', 'on', true);
    update public.attendance set check_out_at = now(), duty_minutes = p_duty_minutes,
           review_status = case when p_result = 'needs_review' then 'needs_review' else review_status end,
           review_reasons = review_reasons || coalesce(p_reasons, '[]'::jsonb)
     where id = v_att.id;
    perform set_config('shg.trusted_attendance', 'off', true);
  end if;

  insert into public.attendance_events (shift_id, staff_id, facility_id, event_type, nonce, client_position_time, distance_m, accuracy_m,
                                        location_age_s, identity_method, result, reasons)
  values (p_shift_id, v_shift.staff_id, v_shift.facility_id, p_event, p_nonce, p_position_time, p_distance_m, p_accuracy_m,
          p_location_age_s, p_identity_method, p_result, coalesce(p_reasons, '[]'::jsonb));
  perform public.write_audit('attendance.mobile_' || p_event, 'shift', p_shift_id::text, v_shift.facility_id,
    jsonb_build_object('result', p_result, 'reasons', p_reasons, 'distance_m', p_distance_m, 'accuracy_m', p_accuracy_m, 'simulated', p_simulated));
  return p_result;
end $$;

-- Admin closes a manual review (verify, or keep unverified with notes).
create or replace function public.review_attendance(p_attendance_id uuid, p_verify boolean, p_notes text) returns text
language plpgsql security definer set search_path = public as $$
declare v_a public.attendance%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_a from public.attendance where id = p_attendance_id for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  if not public.can_admin_facility(v_a.facility_id) then raise exception 'FORBIDDEN'; end if;
  if length(coalesce(trim(p_notes), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;
  update public.attendance set review_status = 'reviewed',
         verification_status = case when p_verify then 'verified' else verification_status end,
         notes = trim(p_notes)
   where id = v_a.id;
  perform public.write_audit('attendance.reviewed', 'attendance', v_a.id::text, v_a.facility_id, jsonb_build_object('verified', p_verify, 'notes', p_notes));
  return 'reviewed';
end $$;

-- ---------------------------------------------------------------------------
-- Temporary reassignment (roster change only after admin approval)
-- ---------------------------------------------------------------------------
create or replace function public.request_reassignment(
  p_staff_id uuid, p_to_facility uuid, p_start date, p_end date, p_reason text, p_recommendation jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_from uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select facility_id into v_from from public.staff where id = p_staff_id and is_active;
  if v_from is null then raise exception 'STAFF_NOT_FOUND'; end if;
  if not (public.can_admin_facility(v_from) and public.can_admin_facility(p_to_facility)) then raise exception 'FORBIDDEN'; end if;
  if p_start < current_date then raise exception 'INVALID_INPUT'; end if;
  insert into public.staff_reassignments (code, staff_id, from_facility_id, to_facility_id, start_date, end_date, reason, recommendation, requested_by)
  values ('RA-' || upper(substr(md5(p_staff_id::text || clock_timestamp()::text), 1, 8)), p_staff_id, v_from, p_to_facility, p_start, p_end,
          trim(p_reason), coalesce(p_recommendation, '{}'::jsonb), auth.uid())
  returning id into v_id;
  perform public.write_audit('reassignment.requested', 'staff_reassignment', v_id::text, p_to_facility,
    jsonb_build_object('staff_id', p_staff_id, 'from', v_from, 'start', p_start, 'end', p_end));
  return v_id;
end $$;

create or replace function public.review_reassignment(p_id uuid, p_approve boolean, p_notes text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_r public.staff_reassignments%rowtype;
  v_type text;
  v_min integer;
  v_day date;
  v_left integer;
  v_moved integer := 0;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_r from public.staff_reassignments where id = p_id for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  if not (public.can_admin_facility(v_r.from_facility_id) and public.can_admin_facility(v_r.to_facility_id)) then raise exception 'FORBIDDEN'; end if;
  if v_r.status <> 'pending' then raise exception 'INVALID_TRANSITION'; end if;

  if not p_approve then
    if length(coalesce(trim(p_notes), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;
    update public.staff_reassignments set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = trim(p_notes) where id = p_id;
    perform public.write_audit('reassignment.rejected', 'staff_reassignment', p_id::text, v_r.to_facility_id, jsonb_build_object('notes', p_notes));
    return 'rejected';
  end if;

  -- Leave conflicts: the doctor must not be on approved leave in the period.
  if exists (select 1 from public.shifts s join public.attendance a on a.shift_id = s.id
              where s.staff_id = v_r.staff_id and s.shift_date between v_r.start_date and v_r.end_date and a.status = 'approved_leave') then
    raise exception 'STAFF_ON_LEAVE';
  end if;
  -- Overlapping approved reassignment.
  if exists (select 1 from public.staff_reassignments x where x.staff_id = v_r.staff_id and x.id <> v_r.id and x.status = 'approved'
              and daterange(x.start_date, x.end_date, '[]') && daterange(v_r.start_date, v_r.end_date, '[]')) then
    raise exception 'REASSIGNMENT_OVERLAP';
  end if;
  -- Donor must keep its minimum rostered doctors on every day.
  select facility_type into v_type from public.health_centres where id = v_r.from_facility_id;
  v_min := case when v_type = 'CHC' then 2 else 1 end;
  for v_day in select generate_series(v_r.start_date, v_r.end_date, interval '1 day')::date loop
    select count(distinct s.staff_id) into v_left from public.shifts s join public.staff st on st.id = s.staff_id and st.is_doctor
      left join public.attendance a on a.shift_id = s.id
     where s.facility_id = v_r.from_facility_id and s.shift_date = v_day and s.staff_id <> v_r.staff_id
       and coalesce(a.status, 'present') not in ('approved_leave', 'absent');
    if v_left < v_min then raise exception 'DONOR_MIN_STAFFING'; end if;
  end loop;

  update public.shifts set facility_id = v_r.to_facility_id, original_facility_id = v_r.from_facility_id, reassignment_id = v_r.id
   where staff_id = v_r.staff_id and facility_id = v_r.from_facility_id and shift_date between v_r.start_date and v_r.end_date
     and not exists (select 1 from public.attendance a where a.shift_id = shifts.id);
  get diagnostics v_moved = row_count;
  if v_moved = 0 then
    insert into public.shifts (facility_id, staff_id, shift_date, shift_type, created_by, original_facility_id, reassignment_id)
    select v_r.to_facility_id, v_r.staff_id, d::date, 'morning', auth.uid(), v_r.from_facility_id, v_r.id
      from generate_series(v_r.start_date, v_r.end_date, interval '1 day') d
    on conflict (staff_id, shift_date, shift_type) do nothing;
  end if;
  update public.staff_reassignments set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(),
         review_notes = nullif(trim(coalesce(p_notes, '')), '') where id = p_id;
  perform public.write_audit('reassignment.approved', 'staff_reassignment', p_id::text, v_r.to_facility_id,
    jsonb_build_object('staff_id', v_r.staff_id, 'from', v_r.from_facility_id, 'shifts_moved', v_moved, 'start', v_r.start_date, 'end', v_r.end_date));
  return 'approved';
end $$;

grant execute on function
  public.record_mobile_attendance(uuid, text, text, text, jsonb, integer, integer, integer, timestamptz, text, boolean, integer),
  public.review_attendance(uuid, boolean, text), public.request_reassignment(uuid, uuid, date, date, text, jsonb),
  public.review_reassignment(uuid, boolean, text)
  to authenticated;
