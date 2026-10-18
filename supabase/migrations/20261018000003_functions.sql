-- Smart Health Grid — transactional stock operations, transfer workflow and
-- integrity triggers.
--
-- Every stock change goes through one of these SECURITY DEFINER functions.
-- Each one:
--   * authorises the caller from public.profiles (auth.uid()),
--   * locks the affected batch rows (SELECT ... FOR UPDATE) to serialise
--     concurrent updates,
--   * rejects negative stock / expired issues,
--   * writes an append-only inventory_transactions row and an audit_logs row,
--   * is idempotent when given an idempotency key (double-submits are no-ops).
-- Errors are raised with stable machine-readable messages that the app maps
-- to translated text.

-- Minimum remaining shelf life (days) for stock to be eligible for transfer.
create or replace function public.min_transfer_shelf_days() returns integer
language sql immutable as $$ select 30 $$;

create or replace function public.write_audit(
  p_action text, p_entity_type text, p_entity_id text, p_facility_id uuid, p_details jsonb
) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, facility_id, details)
  values (auth.uid(), (select role::text from public.profiles where id = auth.uid()),
          p_action, p_entity_type, p_entity_id, p_facility_id, coalesce(p_details, '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- Add a new batch (creates the batch + its receipt transaction atomically)
-- ---------------------------------------------------------------------------
create or replace function public.add_inventory_batch(
  p_facility_id uuid,
  p_medicine_id uuid,
  p_batch_number text,
  p_quantity integer,
  p_expiry_date date,
  p_supplier text,
  p_source text,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_batch_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not public.can_write_facility(p_facility_id) then raise exception 'FORBIDDEN'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 then raise exception 'INVALID_QUANTITY'; end if;
  if p_expiry_date is null or p_expiry_date <= current_date then raise exception 'BATCH_ALREADY_EXPIRED'; end if;

  if p_idempotency_key is not null then
    select batch_id into v_batch_id from public.inventory_transactions where idempotency_key = p_idempotency_key;
    if found then return v_batch_id; end if;
  end if;

  if exists (select 1 from public.inventory_batches
             where facility_id = p_facility_id and medicine_id = p_medicine_id and batch_number = p_batch_number) then
    raise exception 'DUPLICATE_BATCH';
  end if;

  insert into public.inventory_batches
    (facility_id, medicine_id, batch_number, quantity_received, quantity_available, expiry_date, supplier, source, created_by)
  values
    (p_facility_id, p_medicine_id, p_batch_number, p_quantity, p_quantity, p_expiry_date, p_supplier,
     coalesce(p_source, 'state_supply'), auth.uid())
  returning id into v_batch_id;

  insert into public.inventory_transactions
    (facility_id, medicine_id, batch_id, txn_type, quantity, balance_after, reason, idempotency_key, performed_by)
  values
    (p_facility_id, p_medicine_id, v_batch_id, 'receipt', p_quantity, p_quantity, 'New batch received',
     p_idempotency_key, auth.uid());

  perform public.write_audit('inventory.batch_added', 'inventory_batch', v_batch_id::text, p_facility_id,
    jsonb_build_object('medicine_id', p_medicine_id, 'batch_number', p_batch_number,
                       'quantity', p_quantity, 'expiry_date', p_expiry_date));
  return v_batch_id;
end $$;

-- ---------------------------------------------------------------------------
-- Batch-level movement: receipt, adjustment (signed), expiry write-off
-- ---------------------------------------------------------------------------
create or replace function public.record_stock_movement(
  p_batch_id uuid,
  p_txn_type text,
  p_quantity integer,
  p_reason text,
  p_idempotency_key text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_batch public.inventory_batches%rowtype;
  v_delta integer;
  v_new integer;
  v_txn_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;

  if p_idempotency_key is not null then
    select id into v_txn_id from public.inventory_transactions where idempotency_key = p_idempotency_key;
    if found then return v_txn_id; end if;
  end if;

  select * into v_batch from public.inventory_batches where id = p_batch_id for update;
  if not found then raise exception 'BATCH_NOT_FOUND'; end if;
  if not public.can_write_facility(v_batch.facility_id) then raise exception 'FORBIDDEN'; end if;
  if p_quantity is null or p_quantity = 0 or abs(p_quantity) > 1000000 then raise exception 'INVALID_QUANTITY'; end if;

  case p_txn_type
    when 'receipt' then
      if p_quantity < 0 then raise exception 'INVALID_QUANTITY'; end if;
      if v_batch.expiry_date < current_date then raise exception 'BATCH_EXPIRED'; end if;
      v_delta := p_quantity;
    when 'issue' then
      if p_quantity < 0 then raise exception 'INVALID_QUANTITY'; end if;
      if v_batch.expiry_date < current_date then raise exception 'BATCH_EXPIRED'; end if;
      v_delta := -p_quantity;
    when 'adjustment' then
      if length(coalesce(trim(p_reason), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;
      v_delta := p_quantity;
    when 'expiry_writeoff' then
      if p_quantity < 0 then raise exception 'INVALID_QUANTITY'; end if;
      if v_batch.expiry_date >= current_date then raise exception 'BATCH_NOT_EXPIRED'; end if;
      v_delta := -p_quantity;
    else
      raise exception 'INVALID_TXN_TYPE';
  end case;

  v_new := v_batch.quantity_available + v_delta;
  if v_new < 0 then raise exception 'INSUFFICIENT_STOCK'; end if;

  update public.inventory_batches
     set quantity_available = v_new,
         quantity_received = quantity_received + case when p_txn_type = 'receipt' then v_delta else 0 end
   where id = p_batch_id;

  insert into public.inventory_transactions
    (facility_id, medicine_id, batch_id, txn_type, quantity, balance_after, reason, idempotency_key, performed_by)
  values
    (v_batch.facility_id, v_batch.medicine_id, p_batch_id, p_txn_type, v_delta, v_new,
     nullif(trim(coalesce(p_reason, '')), ''), p_idempotency_key, auth.uid())
  returning id into v_txn_id;

  perform public.write_audit('inventory.' || p_txn_type, 'inventory_batch', p_batch_id::text, v_batch.facility_id,
    jsonb_build_object('medicine_id', v_batch.medicine_id, 'batch_number', v_batch.batch_number,
                       'delta', v_delta, 'balance_after', v_new, 'reason', p_reason));
  return v_txn_id;
end $$;

-- ---------------------------------------------------------------------------
-- Issue stock First-Expiry-First-Out across all usable batches
-- ---------------------------------------------------------------------------
create or replace function public.issue_stock_fefo(
  p_facility_id uuid,
  p_medicine_id uuid,
  p_quantity integer,
  p_reason text,
  p_idempotency_key text
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_remaining integer := p_quantity;
  v_take integer;
  v_usable integer;
  v_n integer := 0;
  r record;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not public.can_write_facility(p_facility_id) then raise exception 'FORBIDDEN'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 1000000 then raise exception 'INVALID_QUANTITY'; end if;

  if p_idempotency_key is not null and exists (
    select 1 from public.inventory_transactions where idempotency_key like p_idempotency_key || ':%'
  ) then
    return 0;
  end if;

  -- Lock every usable batch first so the availability check and the
  -- decrements see a consistent snapshot.
  select coalesce(sum(quantity_available), 0) into v_usable
  from (
    select quantity_available from public.inventory_batches
    where facility_id = p_facility_id and medicine_id = p_medicine_id
      and expiry_date >= current_date and quantity_available > 0
    for update
  ) locked;

  if v_usable < p_quantity then raise exception 'INSUFFICIENT_STOCK'; end if;

  for r in
    select id, quantity_available from public.inventory_batches
    where facility_id = p_facility_id and medicine_id = p_medicine_id
      and expiry_date >= current_date and quantity_available > 0
    order by expiry_date, received_at
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, r.quantity_available);
    v_n := v_n + 1;
    update public.inventory_batches set quantity_available = quantity_available - v_take where id = r.id;
    insert into public.inventory_transactions
      (facility_id, medicine_id, batch_id, txn_type, quantity, balance_after, reason, idempotency_key, performed_by)
    values
      (p_facility_id, p_medicine_id, r.id, 'issue', -v_take, r.quantity_available - v_take,
       nullif(trim(coalesce(p_reason, '')), ''),
       case when p_idempotency_key is null then null else p_idempotency_key || ':' || v_n end, auth.uid());
    v_remaining := v_remaining - v_take;
  end loop;

  perform public.write_audit('inventory.issue', 'medicine', p_medicine_id::text, p_facility_id,
    jsonb_build_object('quantity', p_quantity, 'batches_used', v_n, 'reason', p_reason));
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Usable stock helper (non-expired, with optional minimum remaining shelf life)
-- ---------------------------------------------------------------------------
create or replace function public.usable_stock(p_facility_id uuid, p_medicine_id uuid, p_min_shelf_days integer default 0)
returns integer
language sql stable set search_path = public as $$
  select coalesce(sum(quantity_available), 0)::integer
  from public.inventory_batches
  where facility_id = p_facility_id and medicine_id = p_medicine_id
    and expiry_date >= current_date + p_min_shelf_days
$$;

-- ---------------------------------------------------------------------------
-- Transfer review (approve / reject) — district admin only
-- ---------------------------------------------------------------------------
create or replace function public.review_transfer(
  p_transfer_id uuid,
  p_approve boolean,
  p_from_facility_id uuid,
  p_quantity integer,
  p_notes text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_t public.transfer_requests%rowtype;
  v_from uuid;
  v_qty integer;
  v_donor_usable integer;
  v_donor_safety integer;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_t from public.transfer_requests where id = p_transfer_id for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if not public.can_admin_facility(v_t.to_facility_id) then raise exception 'FORBIDDEN'; end if;
  if v_t.status <> 'pending' then raise exception 'TRANSFER_NOT_PENDING'; end if;

  if not p_approve then
    if length(coalesce(trim(p_notes), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;
    update public.transfer_requests
       set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = trim(p_notes)
     where id = p_transfer_id;
    perform public.write_audit('transfer.rejected', 'transfer_request', p_transfer_id::text, v_t.to_facility_id,
      jsonb_build_object('notes', p_notes));
    return 'rejected';
  end if;

  v_from := coalesce(p_from_facility_id, v_t.from_facility_id);
  v_qty := coalesce(p_quantity, v_t.quantity);
  if v_from is null then raise exception 'DONOR_REQUIRED'; end if;
  if v_from = v_t.to_facility_id then raise exception 'SAME_FACILITY'; end if;
  if not public.can_admin_facility(v_from) then raise exception 'FORBIDDEN'; end if;
  if v_qty <= 0 then raise exception 'INVALID_QUANTITY'; end if;

  v_donor_usable := public.usable_stock(v_from, v_t.medicine_id, public.min_transfer_shelf_days());
  select coalesce(min_safety_stock, 0) into v_donor_safety
    from public.facility_medicines where facility_id = v_from and medicine_id = v_t.medicine_id;
  v_donor_safety := coalesce(v_donor_safety, 0);
  if v_donor_usable - v_qty < v_donor_safety then raise exception 'DONOR_BELOW_SAFETY_STOCK'; end if;

  update public.transfer_requests
     set status = 'approved', from_facility_id = v_from, quantity = v_qty,
         reviewed_by = auth.uid(), reviewed_at = now(), review_notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_transfer_id;
  perform public.write_audit('transfer.approved', 'transfer_request', p_transfer_id::text, v_t.to_facility_id,
    jsonb_build_object('from_facility_id', v_from, 'quantity', v_qty, 'donor_usable_before', v_donor_usable,
                       'donor_safety_stock', v_donor_safety));
  return 'approved';
end $$;

-- ---------------------------------------------------------------------------
-- Complete an approved transfer: moves stock FEFO from donor batches to the
-- recipient in ONE transaction, re-validating donor safety stock under lock.
-- ---------------------------------------------------------------------------
create or replace function public.complete_transfer(p_transfer_id uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_t public.transfer_requests%rowtype;
  v_remaining integer;
  v_take integer;
  v_usable integer;
  v_safety integer;
  v_n integer := 0;
  v_dest uuid;
  v_dest_balance integer;
  r record;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_t from public.transfer_requests where id = p_transfer_id for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if v_t.status = 'completed' then return 0; end if; -- idempotent
  if v_t.status <> 'approved' then raise exception 'TRANSFER_NOT_APPROVED'; end if;
  if not (public.can_admin_facility(v_t.from_facility_id) and public.can_admin_facility(v_t.to_facility_id)) then
    raise exception 'FORBIDDEN';
  end if;

  select coalesce(sum(quantity_available), 0) into v_usable
  from (
    select quantity_available from public.inventory_batches
    where facility_id = v_t.from_facility_id and medicine_id = v_t.medicine_id
      and expiry_date >= current_date + public.min_transfer_shelf_days() and quantity_available > 0
    for update
  ) locked;
  select coalesce(min_safety_stock, 0) into v_safety
    from public.facility_medicines where facility_id = v_t.from_facility_id and medicine_id = v_t.medicine_id;
  v_safety := coalesce(v_safety, 0);
  if v_usable < v_t.quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
  if v_usable - v_t.quantity < v_safety then raise exception 'DONOR_BELOW_SAFETY_STOCK'; end if;

  v_remaining := v_t.quantity;
  for r in
    select * from public.inventory_batches
    where facility_id = v_t.from_facility_id and medicine_id = v_t.medicine_id
      and expiry_date >= current_date + public.min_transfer_shelf_days() and quantity_available > 0
    order by expiry_date, received_at
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, r.quantity_available);
    v_n := v_n + 1;

    update public.inventory_batches set quantity_available = quantity_available - v_take where id = r.id;
    insert into public.inventory_transactions
      (facility_id, medicine_id, batch_id, txn_type, quantity, balance_after, reason, reference_type, reference_id, performed_by)
    values
      (v_t.from_facility_id, v_t.medicine_id, r.id, 'transfer_out', -v_take, r.quantity_available - v_take,
       'Transfer ' || v_t.request_code, 'transfer_request', v_t.id, auth.uid());

    insert into public.inventory_batches
      (facility_id, medicine_id, batch_number, quantity_received, quantity_available, expiry_date, supplier, source, created_by)
    values
      (v_t.to_facility_id, v_t.medicine_id, r.batch_number, v_take, v_take, r.expiry_date, r.supplier, 'transfer', auth.uid())
    on conflict (facility_id, medicine_id, batch_number) do update
      set quantity_received = public.inventory_batches.quantity_received + excluded.quantity_received,
          quantity_available = public.inventory_batches.quantity_available + excluded.quantity_available
    returning id, quantity_available into v_dest, v_dest_balance;

    insert into public.inventory_transactions
      (facility_id, medicine_id, batch_id, txn_type, quantity, balance_after, reason, reference_type, reference_id, performed_by)
    values
      (v_t.to_facility_id, v_t.medicine_id, v_dest, 'transfer_in', v_take, v_dest_balance,
       'Transfer ' || v_t.request_code, 'transfer_request', v_t.id, auth.uid());

    v_remaining := v_remaining - v_take;
  end loop;

  update public.transfer_requests
     set status = 'completed', completed_by = auth.uid(), completed_at = now()
   where id = p_transfer_id;

  perform public.write_audit('transfer.completed', 'transfer_request', p_transfer_id::text, v_t.to_facility_id,
    jsonb_build_object('from_facility_id', v_t.from_facility_id, 'quantity', v_t.quantity, 'batches_moved', v_n));
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- Keep health_centres.last_data_update current on operational writes.
create or replace function public.touch_facility_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.health_centres set last_data_update = now() where id = new.facility_id;
  return new;
end $$;

drop trigger if exists touch_facility_patient_stats on public.patient_daily_stats;
create trigger touch_facility_patient_stats after insert or update on public.patient_daily_stats
  for each row execute function public.touch_facility_update();
drop trigger if exists touch_facility_beds on public.bed_status;
create trigger touch_facility_beds after insert or update on public.bed_status
  for each row execute function public.touch_facility_update();
drop trigger if exists touch_facility_diagnostics on public.diagnostic_services;
create trigger touch_facility_diagnostics after insert or update on public.diagnostic_services
  for each row execute function public.touch_facility_update();
drop trigger if exists touch_facility_attendance on public.attendance;
create trigger touch_facility_attendance after insert or update on public.attendance
  for each row execute function public.touch_facility_update();
drop trigger if exists touch_facility_inventory on public.inventory_transactions;
create trigger touch_facility_inventory after insert on public.inventory_transactions
  for each row execute function public.touch_facility_update();

-- Attendance: only district admins verify, and verified records are locked
-- for facility staff. System context (no auth.uid(), e.g. seeding) is exempt.
create or replace function public.enforce_attendance_rules() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;

  if tg_op = 'UPDATE' and old.verification_status = 'verified' and not public.is_district_admin() then
    raise exception 'ATTENDANCE_LOCKED';
  end if;

  if new.verification_status = 'verified'
     and (tg_op = 'INSERT' or old.verification_status <> 'verified') then
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

drop trigger if exists attendance_rules on public.attendance;
create trigger attendance_rules before insert or update on public.attendance
  for each row execute function public.enforce_attendance_rules();

-- Beds: ward totals may not exceed the facility's sanctioned bed capacity.
create or replace function public.enforce_bed_capacity() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_capacity integer;
  v_total integer;
begin
  select bed_capacity into v_capacity from public.health_centres where id = new.facility_id;
  select coalesce(sum(total_beds), 0) into v_total from public.bed_status
   where facility_id = new.facility_id and id <> new.id;
  if v_total + new.total_beds > v_capacity then raise exception 'BED_CAPACITY_EXCEEDED'; end if;
  return new;
end $$;

drop trigger if exists bed_capacity_rules on public.bed_status;
create trigger bed_capacity_rules before insert or update on public.bed_status
  for each row execute function public.enforce_bed_capacity();

grant execute on function
  public.add_inventory_batch(uuid, uuid, text, integer, date, text, text, text),
  public.record_stock_movement(uuid, text, integer, text, text),
  public.issue_stock_fefo(uuid, uuid, integer, text, text),
  public.usable_stock(uuid, uuid, integer),
  public.review_transfer(uuid, boolean, uuid, integer, text),
  public.complete_transfer(uuid),
  public.facility_directory()
  to authenticated;

-- Internal helpers must not be callable directly by clients.
revoke execute on function public.write_audit(text, text, text, uuid, jsonb) from public;
revoke execute on function public.touch_facility_update() from public;
revoke execute on function public.enforce_attendance_rules() from public;
revoke execute on function public.enforce_bed_capacity() from public;
