-- Smart Health Grid — authorization helpers and Row Level Security
--
-- Scope rules
--   district_admin : facilities in profile.district_id (NULL = whole state)
--   read_only      : same read scope as admin, no writes
--   facility_staff : only profile.facility_id
-- Roles are read from public.profiles server-side; client-supplied role values
-- are never trusted. Helper functions are SECURITY DEFINER so policies can read
-- profiles without recursive RLS evaluation.

create or replace function public.current_app_role() returns public.app_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and is_active
$$;

create or replace function public.current_facility_id() returns uuid
language sql stable security definer set search_path = public as $$
  select facility_id from public.profiles where id = auth.uid() and is_active
$$;

create or replace function public.current_district_id() returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(p.district_id, h.district_id)
  from public.profiles p
  left join public.health_centres h on h.id = p.facility_id
  where p.id = auth.uid() and p.is_active
$$;

create or replace function public.is_district_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'district_admin' from public.profiles where id = auth.uid() and is_active), false)
$$;

create or replace function public.can_read_facility(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.profiles p
    join public.health_centres h on h.id = fid
    where p.id = auth.uid() and p.is_active and (
      (p.role in ('district_admin', 'read_only') and (p.district_id is null or h.district_id = p.district_id))
      or (p.role = 'facility_staff' and p.facility_id = fid)
    )
  )
$$;

create or replace function public.can_write_facility(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.profiles p
    join public.health_centres h on h.id = fid
    where p.id = auth.uid() and p.is_active and (
      (p.role = 'district_admin' and (p.district_id is null or h.district_id = p.district_id))
      or (p.role = 'facility_staff' and p.facility_id = fid)
    )
  )
$$;

create or replace function public.can_admin_facility(fid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.profiles p
    join public.health_centres h on h.id = fid
    where p.id = auth.uid() and p.is_active and p.role = 'district_admin'
      and (p.district_id is null or h.district_id = p.district_id)
  )
$$;

-- ---------------------------------------------------------------------------
-- Table privileges. Inventory tables are deliberately NOT writable directly:
-- stock can only change through the audited SECURITY DEFINER functions in
-- the next migration.
-- ---------------------------------------------------------------------------
grant select on all tables in schema public to authenticated;
grant insert, update on
  public.health_centres, public.profiles, public.facility_medicines, public.expected_deliveries,
  public.patient_daily_stats, public.bed_status, public.staff, public.shifts, public.attendance,
  public.diagnostic_services, public.alerts, public.forecasts, public.transfer_requests
  to authenticated;
grant insert on public.alert_events, public.audit_logs to authenticated;
revoke insert, update, delete on public.inventory_batches, public.inventory_transactions from authenticated;
revoke all on all tables in schema public from anon;
grant usage on all sequences in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.districts enable row level security;
alter table public.health_centres enable row level security;
alter table public.profiles enable row level security;
alter table public.medicines enable row level security;
alter table public.facility_medicines enable row level security;
alter table public.inventory_batches enable row level security;
alter table public.inventory_transactions enable row level security;
alter table public.expected_deliveries enable row level security;
alter table public.patient_daily_stats enable row level security;
alter table public.bed_status enable row level security;
alter table public.staff enable row level security;
alter table public.shifts enable row level security;
alter table public.attendance enable row level security;
alter table public.diagnostic_tests enable row level security;
alter table public.diagnostic_services enable row level security;
alter table public.alerts enable row level security;
alter table public.alert_events enable row level security;
alter table public.forecasts enable row level security;
alter table public.transfer_requests enable row level security;
alter table public.audit_logs enable row level security;

-- Reference data -------------------------------------------------------------
drop policy if exists districts_select on public.districts;
create policy districts_select on public.districts for select to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_active
            and p.role <> 'facility_staff' and p.district_id is null)
    or id = public.current_district_id()
  );

drop policy if exists medicines_select on public.medicines;
create policy medicines_select on public.medicines for select to authenticated using (true);

drop policy if exists diagnostic_tests_select on public.diagnostic_tests;
create policy diagnostic_tests_select on public.diagnostic_tests for select to authenticated using (true);

-- Facilities -----------------------------------------------------------------
drop policy if exists health_centres_select on public.health_centres;
create policy health_centres_select on public.health_centres for select to authenticated
  using (public.can_read_facility(id));

drop policy if exists health_centres_insert on public.health_centres;
create policy health_centres_insert on public.health_centres for insert to authenticated
  with check (
    public.is_district_admin()
    and (public.current_district_id() is null or district_id = public.current_district_id())
  );

drop policy if exists health_centres_update on public.health_centres;
create policy health_centres_update on public.health_centres for update to authenticated
  using (public.can_admin_facility(id)) with check (public.can_admin_facility(id));

-- Profiles -------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = auth.uid()
    or (public.current_app_role() in ('district_admin', 'read_only')
        and (public.current_district_id() is null
             or district_id = public.current_district_id()
             or (facility_id is not null and public.can_read_facility(facility_id))))
  );

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles for insert to authenticated
  with check (
    public.is_district_admin()
    and (facility_id is null or public.can_admin_facility(facility_id))
    and (public.current_district_id() is null or district_id = public.current_district_id())
  );

drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
  using (
    public.is_district_admin() and id <> auth.uid()
    and (public.current_district_id() is null or district_id = public.current_district_id())
  )
  with check (
    (facility_id is null or public.can_admin_facility(facility_id))
    and (public.current_district_id() is null or district_id = public.current_district_id())
  );

-- Facility-scoped operational tables ------------------------------------------
-- Read: anyone with read scope. Write: admin of the district or staff of the facility.

drop policy if exists facility_medicines_select on public.facility_medicines;
create policy facility_medicines_select on public.facility_medicines for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists facility_medicines_write on public.facility_medicines;
create policy facility_medicines_write on public.facility_medicines for insert to authenticated
  with check (public.can_admin_facility(facility_id));
drop policy if exists facility_medicines_update on public.facility_medicines;
create policy facility_medicines_update on public.facility_medicines for update to authenticated
  using (public.can_admin_facility(facility_id)) with check (public.can_admin_facility(facility_id));

drop policy if exists inventory_batches_select on public.inventory_batches;
create policy inventory_batches_select on public.inventory_batches for select to authenticated
  using (public.can_read_facility(facility_id));

drop policy if exists inventory_transactions_select on public.inventory_transactions;
create policy inventory_transactions_select on public.inventory_transactions for select to authenticated
  using (public.can_read_facility(facility_id));

drop policy if exists expected_deliveries_select on public.expected_deliveries;
create policy expected_deliveries_select on public.expected_deliveries for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists expected_deliveries_insert on public.expected_deliveries;
create policy expected_deliveries_insert on public.expected_deliveries for insert to authenticated
  with check (public.can_write_facility(facility_id));
drop policy if exists expected_deliveries_update on public.expected_deliveries;
create policy expected_deliveries_update on public.expected_deliveries for update to authenticated
  using (public.can_write_facility(facility_id)) with check (public.can_write_facility(facility_id));

drop policy if exists patient_stats_select on public.patient_daily_stats;
create policy patient_stats_select on public.patient_daily_stats for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists patient_stats_insert on public.patient_daily_stats;
create policy patient_stats_insert on public.patient_daily_stats for insert to authenticated
  with check (public.can_write_facility(facility_id) and recorded_by = auth.uid());
drop policy if exists patient_stats_update on public.patient_daily_stats;
create policy patient_stats_update on public.patient_daily_stats for update to authenticated
  using (public.can_write_facility(facility_id))
  with check (public.can_write_facility(facility_id) and recorded_by = auth.uid());

drop policy if exists bed_status_select on public.bed_status;
create policy bed_status_select on public.bed_status for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists bed_status_insert on public.bed_status;
create policy bed_status_insert on public.bed_status for insert to authenticated
  with check (public.can_write_facility(facility_id));
drop policy if exists bed_status_update on public.bed_status;
create policy bed_status_update on public.bed_status for update to authenticated
  using (public.can_write_facility(facility_id)) with check (public.can_write_facility(facility_id));

drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists staff_insert on public.staff;
create policy staff_insert on public.staff for insert to authenticated
  with check (public.can_admin_facility(facility_id));
drop policy if exists staff_update on public.staff;
create policy staff_update on public.staff for update to authenticated
  using (public.can_admin_facility(facility_id)) with check (public.can_admin_facility(facility_id));

drop policy if exists shifts_select on public.shifts;
create policy shifts_select on public.shifts for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists shifts_insert on public.shifts;
create policy shifts_insert on public.shifts for insert to authenticated
  with check (
    public.can_write_facility(facility_id)
    and exists (select 1 from public.staff s where s.id = staff_id and s.facility_id = shifts.facility_id)
  );

drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists attendance_insert on public.attendance;
create policy attendance_insert on public.attendance for insert to authenticated
  with check (
    public.can_write_facility(facility_id)
    and exists (select 1 from public.shifts s where s.id = shift_id and s.facility_id = attendance.facility_id)
  );
drop policy if exists attendance_update on public.attendance;
create policy attendance_update on public.attendance for update to authenticated
  using (public.can_write_facility(facility_id)) with check (public.can_write_facility(facility_id));

drop policy if exists diagnostic_services_select on public.diagnostic_services;
create policy diagnostic_services_select on public.diagnostic_services for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists diagnostic_services_insert on public.diagnostic_services;
create policy diagnostic_services_insert on public.diagnostic_services for insert to authenticated
  with check (public.can_write_facility(facility_id));
drop policy if exists diagnostic_services_update on public.diagnostic_services;
create policy diagnostic_services_update on public.diagnostic_services for update to authenticated
  using (public.can_write_facility(facility_id)) with check (public.can_write_facility(facility_id));

-- Alerts: everyone in scope reads; only district admins manage. -------------------
drop policy if exists alerts_select on public.alerts;
create policy alerts_select on public.alerts for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists alerts_insert on public.alerts;
create policy alerts_insert on public.alerts for insert to authenticated
  with check (public.can_admin_facility(facility_id));
drop policy if exists alerts_update on public.alerts;
create policy alerts_update on public.alerts for update to authenticated
  using (public.can_admin_facility(facility_id)) with check (public.can_admin_facility(facility_id));

drop policy if exists alert_events_select on public.alert_events;
create policy alert_events_select on public.alert_events for select to authenticated
  using (exists (select 1 from public.alerts a where a.id = alert_id and public.can_read_facility(a.facility_id)));
drop policy if exists alert_events_insert on public.alert_events;
create policy alert_events_insert on public.alert_events for insert to authenticated
  with check (
    actor_id = auth.uid()
    and exists (select 1 from public.alerts a where a.id = alert_id and public.can_admin_facility(a.facility_id))
  );

drop policy if exists forecasts_select on public.forecasts;
create policy forecasts_select on public.forecasts for select to authenticated
  using (public.can_read_facility(facility_id));
drop policy if exists forecasts_insert on public.forecasts;
create policy forecasts_insert on public.forecasts for insert to authenticated
  with check (public.can_admin_facility(facility_id));

-- Facility directory: names/codes of facilities in the caller's district so
-- staff can see who a transfer involves without reading that facility's data.
create or replace function public.facility_directory()
returns table (id uuid, code text, name text, name_hi text, facility_type text, district_id uuid)
language sql stable security definer set search_path = public as $$
  select h.id, h.code, h.name, h.name_hi, h.facility_type, h.district_id
  from public.health_centres h
  where auth.uid() is not null
    and (public.current_district_id() is null or h.district_id = public.current_district_id())
$$;

-- Transfers --------------------------------------------------------------------
drop policy if exists transfers_select on public.transfer_requests;
create policy transfers_select on public.transfer_requests for select to authenticated
  using (public.can_read_facility(from_facility_id) or public.can_read_facility(to_facility_id));

-- Staff may request stock FOR their own facility; admins for any in district.
drop policy if exists transfers_insert on public.transfer_requests;
create policy transfers_insert on public.transfer_requests for insert to authenticated
  with check (
    status = 'pending' and requested_by = auth.uid()
    and public.can_write_facility(to_facility_id)
    and (from_facility_id is null or public.can_admin_facility(from_facility_id))
  );

-- Requesters may cancel their own pending request; approvals go through
-- review_transfer() / complete_transfer().
drop policy if exists transfers_cancel on public.transfer_requests;
create policy transfers_cancel on public.transfer_requests for update to authenticated
  using (requested_by = auth.uid() and status = 'pending')
  with check (requested_by = auth.uid() and status in ('pending', 'cancelled'));

-- Audit log: append by the acting user; readable by admins/officials in scope.
drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select to authenticated
  using (
    public.current_app_role() in ('district_admin', 'read_only')
    and (facility_id is null or public.can_read_facility(facility_id))
  );
drop policy if exists audit_insert on public.audit_logs;
create policy audit_insert on public.audit_logs for insert to authenticated
  with check (actor_id = auth.uid());
