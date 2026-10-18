-- Smart Health Grid — medicine distribution, emergency borrowing and the
-- linked stock-restoration ledger.
--
-- Lifecycle (transfer_requests.status + transfer_events):
--   SHORTAGE_DETECTED (alert) → RECOMMENDATION_CREATED (transfer_recommendations)
--   → AWAITING_APPROVAL → APPROVED / REJECTED → DISPATCHED → RECEIVED
--   → REPLENISHMENT_PENDING (loan obligations open) → STOCK_RESTORED → CLOSED
-- Source stock decreases at DISPATCH; destination stock increases at RECEIPT.
-- A lender's stock increases ONLY when replacement stock is actually received.

-- ---------------------------------------------------------------------------
-- Ledger types and transfer statuses
-- ---------------------------------------------------------------------------
alter table public.inventory_transactions drop constraint if exists inventory_transactions_txn_type_check;
alter table public.inventory_transactions add constraint inventory_transactions_txn_type_check check (txn_type in (
  'receipt', 'issue', 'adjustment', 'transfer_in', 'transfer_out', 'expiry_writeoff',
  'transfer_return', 'replenishment_in', 'restoration_in'));
alter table public.inventory_transactions drop constraint if exists txn_direction;
alter table public.inventory_transactions add constraint txn_direction check (
  (txn_type in ('receipt', 'transfer_in', 'transfer_return', 'replenishment_in', 'restoration_in') and quantity > 0)
  or (txn_type in ('issue', 'transfer_out', 'expiry_writeoff') and quantity < 0)
  or txn_type = 'adjustment');

alter table public.transfer_requests drop constraint if exists transfer_requests_status_check;
alter table public.transfer_requests add constraint transfer_requests_status_check check (status in (
  'pending', 'approved', 'rejected', 'dispatched', 'received', 'replenishment_pending', 'closed',
  'completed', 'cancelled', 'failed'));
alter table public.transfer_requests
  add column if not exists is_loan boolean not null default false,
  add column if not exists decision text check (decision in ('normal_replenishment', 'emergency_borrow', 'emergency_borrow_plus_replenishment', 'escalate')),
  add column if not exists urgency text check (urgency in ('critical', 'high', 'medium', 'low')),
  add column if not exists recommendation_id uuid,
  add column if not exists quantity_dispatched integer not null default 0 check (quantity_dispatched >= 0),
  add column if not exists quantity_received integer not null default 0 check (quantity_received >= 0),
  add column if not exists dispatched_at timestamptz,
  add column if not exists dispatched_by uuid references public.profiles (id) on delete set null,
  add column if not exists received_at timestamptz,
  add column if not exists received_by uuid references public.profiles (id) on delete set null,
  add column if not exists discrepancy_quantity integer not null default 0 check (discrepancy_quantity >= 0),
  add column if not exists discrepancy_notes text,
  add column if not exists failure_reason text;
alter table public.transfer_requests drop constraint if exists dispatch_within_approved;
alter table public.transfer_requests add constraint dispatch_within_approved check (quantity_dispatched <= quantity and quantity_received <= quantity_dispatched);

-- In-flight transfers (awaiting approval, approved or dispatched) are unique per route.
drop index if exists public.transfer_requests_active_idx;
create unique index transfer_requests_active_idx
  on public.transfer_requests (medicine_id, from_facility_id, to_facility_id)
  where status in ('pending', 'approved', 'dispatched');
drop index if exists public.transfer_requests_active_open_idx;
create unique index transfer_requests_active_open_idx
  on public.transfer_requests (medicine_id, to_facility_id)
  where status in ('pending', 'approved', 'dispatched') and from_facility_id is null;

alter table public.alerts drop constraint if exists alerts_category_check;
alter table public.alerts add constraint alerts_category_check check (category in (
  'stock_out', 'stock_risk', 'low_stock', 'expired_stock', 'near_expiry', 'bed_capacity', 'staffing_gap',
  'diagnostic_unavailable', 'diagnostic_stale', 'footfall_spike', 'stale_data', 'manual',
  'restoration_overdue', 'replenishment_failed', 'workload_staffing', 'attendance_review'));

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.transfer_items (
  id uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfer_requests (id) on delete cascade,
  source_batch_id uuid not null references public.inventory_batches (id) on delete restrict,
  batch_number text not null,
  expiry_date date not null,
  quantity_dispatched integer not null check (quantity_dispatched > 0),
  quantity_received integer not null default 0 check (quantity_received >= 0),
  quantity_returned integer not null default 0 check (quantity_returned >= 0),
  dest_batch_id uuid references public.inventory_batches (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint item_received_le_dispatched check (quantity_received + quantity_returned <= quantity_dispatched)
);
create index if not exists transfer_items_transfer_idx on public.transfer_items (transfer_id);

create table if not exists public.transfer_events (
  id bigint generated always as identity primary key,
  transfer_id uuid not null references public.transfer_requests (id) on delete cascade,
  event text not null check (event in (
    'shortage_detected', 'recommendation_created', 'requested', 'approved', 'rejected', 'dispatched', 'received',
    'discrepancy', 'replenishment_pending', 'stock_restored', 'closed', 'cancelled', 'failed', 'returned')),
  quantity integer,
  notes text,
  actor_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists transfer_events_transfer_idx on public.transfer_events (transfer_id, created_at);

create table if not exists public.transfer_recommendations (
  id uuid primary key default gen_random_uuid(),
  recommendation_code text not null unique,
  medicine_id uuid not null references public.medicines (id) on delete cascade,
  recipient_facility_id uuid not null references public.health_centres (id) on delete cascade,
  donor_facility_id uuid references public.health_centres (id) on delete set null,
  decision text not null check (decision in ('normal_replenishment', 'emergency_borrow', 'emergency_borrow_plus_replenishment', 'escalate')),
  urgency text not null check (urgency in ('critical', 'high', 'medium', 'low')),
  required_quantity integer not null check (required_quantity >= 0),
  lendable_quantity integer check (lendable_quantity >= 0),
  proposed_quantity integer not null default 0 check (proposed_quantity >= 0),
  replenishment_quantity integer not null default 0 check (replenishment_quantity >= 0),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'superseded')),
  dedupe_key text not null,
  transfer_id uuid references public.transfer_requests (id) on delete set null,
  decided_by uuid references public.profiles (id) on delete set null,
  decided_at timestamptz,
  decision_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists transfer_recommendations_open_idx on public.transfer_recommendations (dedupe_key) where status = 'open';
drop trigger if exists transfer_recommendations_updated_at on public.transfer_recommendations;
create trigger transfer_recommendations_updated_at before update on public.transfer_recommendations
  for each row execute function public.set_updated_at();

create table if not exists public.borrowing_ledger (
  id uuid primary key default gen_random_uuid(),
  ledger_code text not null unique,
  transfer_id uuid not null unique references public.transfer_requests (id) on delete restrict,
  lender_facility_id uuid not null references public.health_centres (id) on delete restrict,
  borrower_facility_id uuid not null references public.health_centres (id) on delete restrict,
  medicine_id uuid not null references public.medicines (id) on delete restrict,
  quantity_borrowed integer not null check (quantity_borrowed > 0),
  quantity_restored integer not null default 0 check (quantity_restored >= 0),
  status text not null default 'open' check (status in ('open', 'partially_restored', 'restored', 'written_off')),
  due_date date not null,
  batch_details jsonb not null default '[]'::jsonb,
  resolution_notes text,
  resolved_by uuid references public.profiles (id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint restored_le_borrowed check (quantity_restored <= quantity_borrowed)
);
create index if not exists borrowing_ledger_status_idx on public.borrowing_ledger (status, due_date);
drop trigger if exists borrowing_ledger_updated_at on public.borrowing_ledger;
create trigger borrowing_ledger_updated_at before update on public.borrowing_ledger
  for each row execute function public.set_updated_at();

create table if not exists public.replenishment_requests (
  id uuid primary key default gen_random_uuid(),
  request_code text not null unique,
  facility_id uuid not null references public.health_centres (id) on delete cascade,
  medicine_id uuid not null references public.medicines (id) on delete restrict,
  quantity_requested integer not null check (quantity_requested > 0),
  quantity_received integer not null default 0 check (quantity_received >= 0),
  purpose text not null check (purpose in ('routine', 'borrower_replenishment', 'lender_restoration', 'escalation')),
  ledger_id uuid references public.borrowing_ledger (id) on delete set null,
  transfer_id uuid references public.transfer_requests (id) on delete set null,
  recommendation_id uuid references public.transfer_recommendations (id) on delete set null,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'dispatched', 'partially_received', 'received', 'failed', 'cancelled')),
  source text not null default 'district_warehouse',
  due_date date,
  assigned_to uuid references public.profiles (id) on delete set null,
  notes text,
  failure_reason text,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint replenishment_received_le_requested check (quantity_received <= quantity_requested)
);
create index if not exists replenishment_requests_status_idx on public.replenishment_requests (status, facility_id);
drop trigger if exists replenishment_requests_updated_at on public.replenishment_requests;
create trigger replenishment_requests_updated_at before update on public.replenishment_requests
  for each row execute function public.set_updated_at();

create table if not exists public.restoration_events (
  id uuid primary key default gen_random_uuid(),
  ledger_id uuid not null references public.borrowing_ledger (id) on delete cascade,
  replenishment_request_id uuid not null references public.replenishment_requests (id) on delete cascade,
  quantity integer not null check (quantity > 0),
  batch_id uuid references public.inventory_batches (id) on delete set null,
  batch_number text not null,
  expiry_date date not null,
  notes text,
  received_by uuid references public.profiles (id) on delete set null,
  received_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.transfer_items enable row level security;
alter table public.transfer_events enable row level security;
alter table public.transfer_recommendations enable row level security;
alter table public.borrowing_ledger enable row level security;
alter table public.replenishment_requests enable row level security;
alter table public.restoration_events enable row level security;
grant select on public.transfer_items, public.transfer_events, public.transfer_recommendations, public.borrowing_ledger,
  public.replenishment_requests, public.restoration_events to authenticated;
revoke insert, update, delete on public.transfer_items, public.transfer_events, public.borrowing_ledger,
  public.restoration_events, public.transfer_recommendations, public.replenishment_requests from authenticated;

create or replace function public.can_read_transfer(tid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.transfer_requests t where t.id = tid
    and (public.can_read_facility(t.to_facility_id) or (t.from_facility_id is not null and public.can_read_facility(t.from_facility_id))))
$$;

create policy transfer_items_select on public.transfer_items for select to authenticated using (public.can_read_transfer(transfer_id));
create policy transfer_events_select on public.transfer_events for select to authenticated using (public.can_read_transfer(transfer_id));
create policy recommendations_select on public.transfer_recommendations for select to authenticated using (
  public.can_read_facility(recipient_facility_id) or (donor_facility_id is not null and public.can_read_facility(donor_facility_id)));
create policy ledger_select on public.borrowing_ledger for select to authenticated using (
  public.can_read_facility(lender_facility_id) or public.can_read_facility(borrower_facility_id));
create policy replenishment_select on public.replenishment_requests for select to authenticated using (public.can_read_facility(facility_id));
create policy restoration_select on public.restoration_events for select to authenticated using (
  exists (select 1 from public.borrowing_ledger l where l.id = ledger_id
    and (public.can_read_facility(l.lender_facility_id) or public.can_read_facility(l.borrower_facility_id))));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.transfer_event(p_transfer uuid, p_event text, p_qty integer, p_notes text)
returns void language sql security definer set search_path = public as $$
  insert into public.transfer_events (transfer_id, event, quantity, notes, actor_id) values (p_transfer, p_event, p_qty, p_notes, auth.uid());
$$;
revoke execute on function public.transfer_event(uuid, text, integer, text) from public;

-- Quantity already committed (approved, not yet dispatched) from a donor.
create or replace function public.committed_outgoing(p_facility uuid, p_medicine uuid, p_exclude uuid default null) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(quantity), 0)::integer from public.transfer_requests
   where from_facility_id = p_facility and medicine_id = p_medicine and status = 'approved'
     and (p_exclude is null or id <> p_exclude)
$$;

-- ---------------------------------------------------------------------------
-- Dispatch: decrement donor stock FEFO (usable, ≥ min shelf life), record
-- items. Partial dispatch allowed (≤ approved). Idempotent once dispatched.
-- ---------------------------------------------------------------------------
create or replace function public.dispatch_transfer(p_transfer_id uuid, p_quantity integer, p_notes text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_t public.transfer_requests%rowtype;
  v_usable integer;
  v_safety integer;
  v_committed integer;
  v_remaining integer;
  v_take integer;
  r record;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_t from public.transfer_requests where id = p_transfer_id for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if v_t.status in ('dispatched', 'received', 'replenishment_pending', 'closed') then return v_t.quantity_dispatched; end if;
  if v_t.status <> 'approved' then raise exception 'TRANSFER_NOT_APPROVED'; end if;
  if v_t.from_facility_id is null then raise exception 'DONOR_REQUIRED'; end if;
  if not public.can_write_facility(v_t.from_facility_id) then raise exception 'FORBIDDEN'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > v_t.quantity then raise exception 'INVALID_QUANTITY'; end if;
  if p_quantity < v_t.quantity and length(coalesce(trim(p_notes), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;

  select coalesce(sum(quantity_available), 0) into v_usable from (
    select quantity_available from public.inventory_batches
     where facility_id = v_t.from_facility_id and medicine_id = v_t.medicine_id
       and expiry_date >= current_date + public.min_transfer_shelf_days() and quantity_available > 0
     for update) locked;
  select coalesce(min_safety_stock, 0) into v_safety from public.facility_medicines
   where facility_id = v_t.from_facility_id and medicine_id = v_t.medicine_id;
  v_committed := public.committed_outgoing(v_t.from_facility_id, v_t.medicine_id, v_t.id);
  if v_usable < p_quantity then raise exception 'INSUFFICIENT_STOCK'; end if;
  if v_usable - p_quantity - v_committed < coalesce(v_safety, 0) then raise exception 'DONOR_BELOW_SAFETY_STOCK'; end if;

  v_remaining := p_quantity;
  for r in
    select * from public.inventory_batches
     where facility_id = v_t.from_facility_id and medicine_id = v_t.medicine_id
       and expiry_date >= current_date + public.min_transfer_shelf_days() and quantity_available > 0
     order by expiry_date, received_at
  loop
    exit when v_remaining <= 0;
    v_take := least(v_remaining, r.quantity_available);
    update public.inventory_batches set quantity_available = quantity_available - v_take where id = r.id;
    insert into public.inventory_transactions (facility_id, medicine_id, batch_id, txn_type, quantity, balance_after, reason,
                                               reference_type, reference_id, performed_by)
    values (v_t.from_facility_id, v_t.medicine_id, r.id, 'transfer_out', -v_take, r.quantity_available - v_take,
            'Dispatched ' || v_t.request_code, 'transfer_request', v_t.id, auth.uid());
    insert into public.transfer_items (transfer_id, source_batch_id, batch_number, expiry_date, quantity_dispatched)
    values (v_t.id, r.id, r.batch_number, r.expiry_date, v_take);
    v_remaining := v_remaining - v_take;
  end loop;

  update public.transfer_requests set status = 'dispatched', quantity_dispatched = p_quantity, dispatched_at = now(), dispatched_by = auth.uid()
   where id = v_t.id;
  perform public.transfer_event(v_t.id, 'dispatched', p_quantity, nullif(trim(coalesce(p_notes, '')), ''));
  perform public.write_audit('transfer.dispatched', 'transfer_request', v_t.id::text, v_t.from_facility_id,
    jsonb_build_object('quantity', p_quantity, 'approved', v_t.quantity));
  return p_quantity;
end $$;

-- ---------------------------------------------------------------------------
-- Receipt: recipient confirms quantity received (≤ dispatched). A shortfall
-- is recorded as a discrepancy with mandatory notes. Loans create a borrowing
-- ledger entry and a linked lender-restoration request.
-- ---------------------------------------------------------------------------
create or replace function public.receive_transfer(p_transfer_id uuid, p_quantity integer, p_notes text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_t public.transfer_requests%rowtype;
  v_left integer;
  v_take integer;
  v_dest uuid;
  v_bal integer;
  v_ledger uuid;
  v_batches jsonb := '[]'::jsonb;
  v_status text;
  r record;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_t from public.transfer_requests where id = p_transfer_id for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if v_t.status in ('received', 'replenishment_pending', 'closed') then return v_t.status; end if;
  if v_t.status <> 'dispatched' then raise exception 'TRANSFER_NOT_DISPATCHED'; end if;
  if not public.can_write_facility(v_t.to_facility_id) then raise exception 'FORBIDDEN'; end if;
  if p_quantity is null or p_quantity < 0 or p_quantity > v_t.quantity_dispatched then raise exception 'INVALID_QUANTITY'; end if;
  if p_quantity < v_t.quantity_dispatched and length(coalesce(trim(p_notes), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;
  if p_quantity = 0 then raise exception 'INVALID_QUANTITY'; end if;

  v_left := p_quantity;
  for r in select * from public.transfer_items where transfer_id = v_t.id order by expiry_date, created_at for update loop
    exit when v_left <= 0;
    v_take := least(v_left, r.quantity_dispatched - r.quantity_received - r.quantity_returned);
    continue when v_take <= 0;
    insert into public.inventory_batches (facility_id, medicine_id, batch_number, quantity_received, quantity_available, expiry_date, source, created_by)
    values (v_t.to_facility_id, v_t.medicine_id, r.batch_number, v_take, v_take, r.expiry_date, 'transfer', auth.uid())
    on conflict (facility_id, medicine_id, batch_number) do update
      set quantity_received = public.inventory_batches.quantity_received + excluded.quantity_received,
          quantity_available = public.inventory_batches.quantity_available + excluded.quantity_available
    returning id, quantity_available into v_dest, v_bal;
    insert into public.inventory_transactions (facility_id, medicine_id, batch_id, txn_type, quantity, balance_after, reason,
                                               reference_type, reference_id, performed_by)
    values (v_t.to_facility_id, v_t.medicine_id, v_dest, 'transfer_in', v_take, v_bal, 'Received ' || v_t.request_code,
            'transfer_request', v_t.id, auth.uid());
    update public.transfer_items set quantity_received = quantity_received + v_take, dest_batch_id = v_dest where id = r.id;
    v_batches := v_batches || jsonb_build_object('batch_number', r.batch_number, 'expiry_date', r.expiry_date, 'quantity', v_take);
    v_left := v_left - v_take;
  end loop;

  update public.transfer_requests
     set quantity_received = p_quantity, received_at = now(), received_by = auth.uid(),
         discrepancy_quantity = quantity_dispatched - p_quantity,
         discrepancy_notes = case when p_quantity < quantity_dispatched then trim(p_notes) else null end
   where id = v_t.id;
  perform public.transfer_event(v_t.id, 'received', p_quantity, nullif(trim(coalesce(p_notes, '')), ''));
  if p_quantity < v_t.quantity_dispatched then
    perform public.transfer_event(v_t.id, 'discrepancy', v_t.quantity_dispatched - p_quantity, trim(p_notes));
  end if;

  if v_t.is_loan then
    insert into public.borrowing_ledger (ledger_code, transfer_id, lender_facility_id, borrower_facility_id, medicine_id,
                                         quantity_borrowed, due_date, batch_details)
    values ('LOAN-' || upper(substr(md5(v_t.id::text), 1, 8)), v_t.id, v_t.from_facility_id, v_t.to_facility_id, v_t.medicine_id,
            p_quantity, current_date + 14, v_batches)
    returning id into v_ledger;
    -- Lender's restoration claim: tracked separately from the borrower's own replenishment.
    insert into public.replenishment_requests (request_code, facility_id, medicine_id, quantity_requested, purpose, ledger_id,
                                               transfer_id, due_date, notes, created_by)
    values ('RST-' || upper(substr(md5(v_ledger::text), 1, 8)), v_t.from_facility_id, v_t.medicine_id, p_quantity,
            'lender_restoration', v_ledger, v_t.id, current_date + 14,
            'Restore stock lent under ' || v_t.request_code, auth.uid());
    update public.replenishment_requests set ledger_id = v_ledger where transfer_id = v_t.id and purpose = 'borrower_replenishment';
    update public.transfer_requests set status = 'replenishment_pending' where id = v_t.id;
    perform public.transfer_event(v_t.id, 'replenishment_pending', p_quantity, 'Borrowing ledger opened; lender restoration requested');
    v_status := 'replenishment_pending';
  else
    update public.transfer_requests set status = 'closed' where id = v_t.id;
    perform public.transfer_event(v_t.id, 'closed', null, 'Redistribution received');
    v_status := 'closed';
  end if;

  perform public.write_audit('transfer.received', 'transfer_request', v_t.id::text, v_t.to_facility_id,
    jsonb_build_object('received', p_quantity, 'dispatched', v_t.quantity_dispatched, 'ledger_id', v_ledger));
  return v_status;
end $$;

-- ---------------------------------------------------------------------------
-- Failed delivery: unreceived stock returns to the donor's original batches.
-- ---------------------------------------------------------------------------
create or replace function public.fail_transfer(p_transfer_id uuid, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_t public.transfer_requests%rowtype;
  v_back integer;
  r record;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if length(coalesce(trim(p_reason), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;
  select * into v_t from public.transfer_requests where id = p_transfer_id for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if not public.can_admin_facility(v_t.to_facility_id) then raise exception 'FORBIDDEN'; end if;
  if v_t.status in ('pending', 'approved') then
    update public.transfer_requests set status = 'cancelled', failure_reason = trim(p_reason) where id = v_t.id;
    perform public.transfer_event(v_t.id, 'cancelled', null, trim(p_reason));
    return 'cancelled';
  end if;
  if v_t.status <> 'dispatched' then raise exception 'INVALID_TRANSITION'; end if;
  for r in select * from public.transfer_items where transfer_id = v_t.id for update loop
    v_back := r.quantity_dispatched - r.quantity_received - r.quantity_returned;
    continue when v_back <= 0;
    update public.inventory_batches set quantity_available = quantity_available + v_back where id = r.source_batch_id;
    insert into public.inventory_transactions (facility_id, medicine_id, batch_id, txn_type, quantity, balance_after, reason,
                                               reference_type, reference_id, performed_by)
    select v_t.from_facility_id, v_t.medicine_id, r.source_batch_id, 'transfer_return', v_back, b.quantity_available,
           'Failed delivery ' || v_t.request_code, 'transfer_request', v_t.id, auth.uid()
      from public.inventory_batches b where b.id = r.source_batch_id;
    update public.transfer_items set quantity_returned = quantity_returned + v_back where id = r.id;
  end loop;
  update public.transfer_requests set status = 'failed', failure_reason = trim(p_reason) where id = v_t.id;
  perform public.transfer_event(v_t.id, 'failed', v_t.quantity_dispatched, trim(p_reason));
  perform public.transfer_event(v_t.id, 'returned', v_t.quantity_dispatched, 'Stock returned to donor batches');
  perform public.write_audit('transfer.failed', 'transfer_request', v_t.id::text, v_t.to_facility_id, jsonb_build_object('reason', p_reason));
  return 'failed';
end $$;

-- ---------------------------------------------------------------------------
-- Replenishment receipt (warehouse delivery confirmed at the facility).
-- For lender restoration this is the ONLY way the lender's stock is restored.
-- ---------------------------------------------------------------------------
create or replace function public.receive_replenishment(
  p_request_id uuid, p_quantity integer, p_batch_number text, p_expiry date, p_notes text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_r public.replenishment_requests%rowtype;
  v_batch uuid;
  v_bal integer;
  v_l public.borrowing_ledger%rowtype;
  v_new_status text;
  v_transfer_open integer;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_r from public.replenishment_requests where id = p_request_id for update;
  if not found then raise exception 'REPLENISHMENT_NOT_FOUND'; end if;
  if not public.can_write_facility(v_r.facility_id) then raise exception 'FORBIDDEN'; end if;
  if v_r.status not in ('requested', 'approved', 'dispatched', 'partially_received') then raise exception 'INVALID_TRANSITION'; end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > v_r.quantity_requested - v_r.quantity_received then raise exception 'INVALID_QUANTITY'; end if;
  if p_expiry is null or p_expiry <= current_date then raise exception 'BATCH_ALREADY_EXPIRED'; end if;
  if p_batch_number !~ '^[A-Za-z0-9/_-]{2,40}$' then raise exception 'INVALID_INPUT'; end if;

  insert into public.inventory_batches (facility_id, medicine_id, batch_number, quantity_received, quantity_available, expiry_date,
                                        supplier, source, created_by)
  values (v_r.facility_id, v_r.medicine_id, p_batch_number, p_quantity, p_quantity, p_expiry, 'District warehouse', 'district_warehouse', auth.uid())
  on conflict (facility_id, medicine_id, batch_number) do update
    set quantity_received = public.inventory_batches.quantity_received + excluded.quantity_received,
        quantity_available = public.inventory_batches.quantity_available + excluded.quantity_available
  returning id, quantity_available into v_batch, v_bal;
  insert into public.inventory_transactions (facility_id, medicine_id, batch_id, txn_type, quantity, balance_after, reason,
                                             reference_type, reference_id, performed_by)
  values (v_r.facility_id, v_r.medicine_id, v_batch,
          case when v_r.purpose = 'lender_restoration' then 'restoration_in' else 'replenishment_in' end,
          p_quantity, v_bal, 'Replenishment ' || v_r.request_code, 'replenishment_request', v_r.id, auth.uid());

  v_new_status := case when v_r.quantity_received + p_quantity >= v_r.quantity_requested then 'received' else 'partially_received' end;
  update public.replenishment_requests set quantity_received = quantity_received + p_quantity, status = v_new_status,
         notes = coalesce(nullif(trim(coalesce(p_notes, '')), ''), notes)
   where id = v_r.id;

  if v_r.purpose = 'lender_restoration' and v_r.ledger_id is not null then
    select * into v_l from public.borrowing_ledger where id = v_r.ledger_id for update;
    insert into public.restoration_events (ledger_id, replenishment_request_id, quantity, batch_id, batch_number, expiry_date, notes, received_by)
    values (v_l.id, v_r.id, p_quantity, v_batch, p_batch_number, p_expiry, nullif(trim(coalesce(p_notes, '')), ''), auth.uid());
    update public.borrowing_ledger
       set quantity_restored = least(quantity_borrowed, quantity_restored + p_quantity),
           status = case when quantity_restored + p_quantity >= quantity_borrowed then 'restored' else 'partially_restored' end,
           closed_at = case when quantity_restored + p_quantity >= quantity_borrowed then now() else null end
     where id = v_l.id;
    if v_l.quantity_restored + p_quantity >= v_l.quantity_borrowed then
      perform public.transfer_event(v_l.transfer_id, 'stock_restored', v_l.quantity_borrowed, 'Lender stock fully restored');
    end if;
  end if;

  -- Close the loan once the lender is restored and any borrower replenishment is done.
  if v_r.transfer_id is not null then
    select count(*) into v_transfer_open from public.borrowing_ledger l
     where l.transfer_id = v_r.transfer_id and l.status in ('open', 'partially_restored');
    if v_transfer_open = 0 and not exists (
         select 1 from public.replenishment_requests x where x.transfer_id = v_r.transfer_id and x.purpose = 'borrower_replenishment'
            and x.status not in ('received', 'cancelled')) then
      update public.transfer_requests set status = 'closed' where id = v_r.transfer_id and status = 'replenishment_pending';
      if found then perform public.transfer_event(v_r.transfer_id, 'closed', null, 'All obligations settled'); end if;
    end if;
  end if;

  perform public.write_audit('replenishment.received', 'replenishment_request', v_r.id::text, v_r.facility_id,
    jsonb_build_object('quantity', p_quantity, 'purpose', v_r.purpose, 'batch', p_batch_number));
  return v_new_status;
end $$;

create or replace function public.fail_replenishment(p_request_id uuid, p_reason text) returns text
language plpgsql security definer set search_path = public as $$
declare v_r public.replenishment_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if length(coalesce(trim(p_reason), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;
  select * into v_r from public.replenishment_requests where id = p_request_id for update;
  if not found then raise exception 'REPLENISHMENT_NOT_FOUND'; end if;
  if not public.can_admin_facility(v_r.facility_id) then raise exception 'FORBIDDEN'; end if;
  if v_r.status in ('received', 'failed', 'cancelled') then raise exception 'INVALID_TRANSITION'; end if;
  update public.replenishment_requests set status = 'failed', failure_reason = trim(p_reason) where id = v_r.id;
  perform public.write_audit('replenishment.failed', 'replenishment_request', v_r.id::text, v_r.facility_id, jsonb_build_object('reason', p_reason));
  return 'failed';
end $$;

-- Re-issue a failed restoration/replenishment for the outstanding quantity.
create or replace function public.reissue_replenishment(p_request_id uuid, p_due date) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_r public.replenishment_requests%rowtype; v_id uuid;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_r from public.replenishment_requests where id = p_request_id for update;
  if not found then raise exception 'REPLENISHMENT_NOT_FOUND'; end if;
  if not public.can_admin_facility(v_r.facility_id) then raise exception 'FORBIDDEN'; end if;
  if v_r.status <> 'failed' then raise exception 'INVALID_TRANSITION'; end if;
  insert into public.replenishment_requests (request_code, facility_id, medicine_id, quantity_requested, purpose, ledger_id, transfer_id,
                                             recommendation_id, due_date, notes, created_by)
  values (v_r.request_code || '-R' || (select count(*) + 1 from public.replenishment_requests where request_code like v_r.request_code || '-R%'),
          v_r.facility_id, v_r.medicine_id, v_r.quantity_requested - v_r.quantity_received, v_r.purpose, v_r.ledger_id, v_r.transfer_id,
          v_r.recommendation_id, coalesce(p_due, current_date + 7), 'Re-issued after failure: ' || coalesce(v_r.failure_reason, ''), auth.uid())
  returning id into v_id;
  update public.replenishment_requests set status = 'cancelled' where id = v_r.id;
  perform public.write_audit('replenishment.reissued', 'replenishment_request', v_id::text, v_r.facility_id, jsonb_build_object('from', v_r.id));
  return v_id;
end $$;

create or replace function public.update_replenishment_status(p_request_id uuid, p_status text, p_assignee uuid) returns text
language plpgsql security definer set search_path = public as $$
declare v_r public.replenishment_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_r from public.replenishment_requests where id = p_request_id for update;
  if not found then raise exception 'REPLENISHMENT_NOT_FOUND'; end if;
  if not public.can_admin_facility(v_r.facility_id) then raise exception 'FORBIDDEN'; end if;
  if p_status not in ('approved', 'dispatched') or v_r.status not in ('requested', 'approved', 'partially_received') then raise exception 'INVALID_TRANSITION'; end if;
  update public.replenishment_requests set status = p_status, assigned_to = coalesce(p_assignee, assigned_to, auth.uid()) where id = v_r.id;
  perform public.write_audit('replenishment.' || p_status, 'replenishment_request', v_r.id::text, v_r.facility_id, '{}'::jsonb);
  return p_status;
end $$;

-- Authorised, documented write-off of an outstanding obligation.
create or replace function public.resolve_ledger(p_ledger_id uuid, p_notes text) returns text
language plpgsql security definer set search_path = public as $$
declare v_l public.borrowing_ledger%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if length(coalesce(trim(p_notes), '')) < 10 then raise exception 'REASON_REQUIRED'; end if;
  select * into v_l from public.borrowing_ledger where id = p_ledger_id for update;
  if not found then raise exception 'LEDGER_NOT_FOUND'; end if;
  if not public.can_admin_facility(v_l.lender_facility_id) then raise exception 'FORBIDDEN'; end if;
  if v_l.status not in ('open', 'partially_restored') then raise exception 'INVALID_TRANSITION'; end if;
  update public.borrowing_ledger set status = 'written_off', resolution_notes = trim(p_notes), resolved_by = auth.uid(), closed_at = now()
   where id = v_l.id;
  update public.replenishment_requests set status = 'cancelled' where ledger_id = v_l.id and purpose = 'lender_restoration'
     and status in ('requested', 'approved', 'dispatched', 'failed');
  update public.transfer_requests set status = 'closed' where id = v_l.transfer_id and status = 'replenishment_pending';
  perform public.transfer_event(v_l.transfer_id, 'closed', null, 'Obligation resolved: ' || trim(p_notes));
  perform public.write_audit('ledger.resolved', 'borrowing_ledger', v_l.id::text, v_l.lender_facility_id, jsonb_build_object('notes', p_notes));
  return 'written_off';
end $$;

grant execute on function
  public.dispatch_transfer(uuid, integer, text), public.receive_transfer(uuid, integer, text), public.fail_transfer(uuid, text),
  public.receive_replenishment(uuid, integer, text, date, text), public.fail_replenishment(uuid, text),
  public.reissue_replenishment(uuid, date), public.update_replenishment_status(uuid, text, uuid), public.resolve_ledger(uuid, text),
  public.committed_outgoing(uuid, uuid, uuid)
  to authenticated;

-- Approval re-validates donor capacity INCLUDING stock already committed to
-- other approved (not yet dispatched) transfers — prevents double allocation.
create or replace function public.review_transfer(
  p_transfer_id uuid, p_approve boolean, p_from_facility_id uuid, p_quantity integer, p_notes text
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_t public.transfer_requests%rowtype;
  v_from uuid;
  v_qty integer;
  v_usable integer;
  v_safety integer;
  v_committed integer;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_t from public.transfer_requests where id = p_transfer_id for update;
  if not found then raise exception 'TRANSFER_NOT_FOUND'; end if;
  if not public.can_admin_facility(v_t.to_facility_id) then raise exception 'FORBIDDEN'; end if;
  if v_t.status <> 'pending' then raise exception 'TRANSFER_NOT_PENDING'; end if;

  if not p_approve then
    if length(coalesce(trim(p_notes), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;
    update public.transfer_requests set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_notes = trim(p_notes)
     where id = p_transfer_id;
    perform public.transfer_event(p_transfer_id, 'rejected', null, trim(p_notes));
    perform public.write_audit('transfer.rejected', 'transfer_request', p_transfer_id::text, v_t.to_facility_id, jsonb_build_object('notes', p_notes));
    return 'rejected';
  end if;

  v_from := coalesce(p_from_facility_id, v_t.from_facility_id);
  v_qty := coalesce(p_quantity, v_t.quantity);
  if v_from is null then raise exception 'DONOR_REQUIRED'; end if;
  if v_from = v_t.to_facility_id then raise exception 'SAME_FACILITY'; end if;
  if not public.can_admin_facility(v_from) then raise exception 'FORBIDDEN'; end if;
  if v_qty <= 0 then raise exception 'INVALID_QUANTITY'; end if;

  -- Lock donor batches so concurrent approvals see a consistent picture.
  select coalesce(sum(quantity_available), 0) into v_usable from (
    select quantity_available from public.inventory_batches
     where facility_id = v_from and medicine_id = v_t.medicine_id
       and expiry_date >= current_date + public.min_transfer_shelf_days() and quantity_available > 0
     for update) locked;
  select coalesce(min_safety_stock, 0) into v_safety from public.facility_medicines where facility_id = v_from and medicine_id = v_t.medicine_id;
  v_committed := public.committed_outgoing(v_from, v_t.medicine_id, v_t.id);
  if v_usable - v_committed - v_qty < coalesce(v_safety, 0) then raise exception 'DONOR_BELOW_SAFETY_STOCK'; end if;

  update public.transfer_requests
     set status = 'approved', from_facility_id = v_from, quantity = v_qty,
         reviewed_by = auth.uid(), reviewed_at = now(), review_notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = p_transfer_id;
  perform public.transfer_event(p_transfer_id, 'approved', v_qty, nullif(trim(coalesce(p_notes, '')), ''));
  perform public.write_audit('transfer.approved', 'transfer_request', p_transfer_id::text, v_t.to_facility_id,
    jsonb_build_object('from_facility_id', v_from, 'quantity', v_qty, 'donor_usable', v_usable, 'committed', v_committed, 'safety', v_safety));
  return 'approved';
end $$;

-- ---------------------------------------------------------------------------
-- Approve / reject a recommendation (district admin). The server recomputes
-- the recommendation before calling this; the function re-validates donor
-- safety stock and commitments under lock, then atomically creates the
-- approved loan transfer and/or the linked warehouse replenishment request.
-- ---------------------------------------------------------------------------
create or replace function public.approve_recommendation(
  p_recommendation_id uuid, p_donor uuid, p_quantity integer, p_replenishment_quantity integer, p_notes text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_rec public.transfer_recommendations%rowtype;
  v_tid uuid;
  v_usable integer;
  v_safety integer;
  v_committed integer;
  v_code text;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_rec from public.transfer_recommendations where id = p_recommendation_id for update;
  if not found then raise exception 'RECOMMENDATION_STALE'; end if;
  if v_rec.status <> 'open' then raise exception 'RECOMMENDATION_STALE'; end if;
  if not public.can_admin_facility(v_rec.recipient_facility_id) then raise exception 'FORBIDDEN'; end if;

  if v_rec.decision in ('emergency_borrow', 'emergency_borrow_plus_replenishment') then
    if p_donor is null then raise exception 'DONOR_REQUIRED'; end if;
    if not public.can_admin_facility(p_donor) then raise exception 'FORBIDDEN'; end if;
    if p_quantity is null or p_quantity <= 0 then raise exception 'INVALID_QUANTITY'; end if;
    select coalesce(sum(quantity_available), 0) into v_usable from (
      select quantity_available from public.inventory_batches
       where facility_id = p_donor and medicine_id = v_rec.medicine_id
         and expiry_date >= current_date + public.min_transfer_shelf_days() and quantity_available > 0
       for update) locked;
    select coalesce(min_safety_stock, 0) into v_safety from public.facility_medicines where facility_id = p_donor and medicine_id = v_rec.medicine_id;
    v_committed := public.committed_outgoing(p_donor, v_rec.medicine_id, null);
    if v_usable - v_committed - p_quantity < coalesce(v_safety, 0) then raise exception 'DONOR_BELOW_SAFETY_STOCK'; end if;

    v_code := 'LN-' || to_char(current_date, 'YYYYMMDD') || '-' || upper(substr(md5(v_rec.id::text || clock_timestamp()::text), 1, 5));
    insert into public.transfer_requests (request_code, medicine_id, from_facility_id, to_facility_id, quantity, status, origin, justification,
                                          calculation, requested_by, reviewed_by, reviewed_at, review_notes, is_loan, decision, urgency, recommendation_id)
    values (v_code, v_rec.medicine_id, p_donor, v_rec.recipient_facility_id, p_quantity, 'approved', 'recommendation',
            'Emergency loan: ' || v_rec.recommendation_code, v_rec.payload, auth.uid(), auth.uid(), now(),
            nullif(trim(coalesce(p_notes, '')), ''), true, v_rec.decision, v_rec.urgency, v_rec.id)
    returning id into v_tid;
    insert into public.transfer_events (transfer_id, event, quantity, notes, actor_id, created_at) values
      (v_tid, 'shortage_detected', v_rec.required_quantity, 'Shortage detected by stock projection', null, v_rec.created_at),
      (v_tid, 'recommendation_created', v_rec.proposed_quantity, v_rec.recommendation_code, null, v_rec.created_at);
    perform public.transfer_event(v_tid, 'approved', p_quantity, nullif(trim(coalesce(p_notes, '')), ''));
  end if;

  if v_rec.decision in ('emergency_borrow_plus_replenishment', 'normal_replenishment', 'escalate') and coalesce(p_replenishment_quantity, 0) > 0 then
    insert into public.replenishment_requests (request_code, facility_id, medicine_id, quantity_requested, purpose, transfer_id,
                                               recommendation_id, due_date, notes, created_by)
    values ('RPL-' || upper(substr(md5(v_rec.id::text || clock_timestamp()::text), 1, 8)), v_rec.recipient_facility_id, v_rec.medicine_id,
            p_replenishment_quantity,
            case v_rec.decision when 'normal_replenishment' then 'routine' when 'escalate' then 'escalation' else 'borrower_replenishment' end,
            v_tid, v_rec.id,
            current_date + case v_rec.urgency when 'critical' then 2 when 'high' then 4 else 7 end,
            'From ' || v_rec.recommendation_code, auth.uid());
  end if;

  update public.transfer_recommendations set status = 'accepted', transfer_id = v_tid, decided_by = auth.uid(), decided_at = now(),
         decision_notes = nullif(trim(coalesce(p_notes, '')), '')
   where id = v_rec.id;
  perform public.write_audit('recommendation.approved', 'transfer_recommendation', v_rec.id::text, v_rec.recipient_facility_id,
    jsonb_build_object('decision', v_rec.decision, 'donor', p_donor, 'quantity', p_quantity, 'replenishment', p_replenishment_quantity, 'transfer_id', v_tid));
  return coalesce(v_tid, v_rec.id);
end $$;

create or replace function public.reject_recommendation(p_recommendation_id uuid, p_notes text) returns text
language plpgsql security definer set search_path = public as $$
declare v_rec public.transfer_recommendations%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if length(coalesce(trim(p_notes), '')) < 5 then raise exception 'REASON_REQUIRED'; end if;
  select * into v_rec from public.transfer_recommendations where id = p_recommendation_id for update;
  if not found or v_rec.status <> 'open' then raise exception 'RECOMMENDATION_STALE'; end if;
  if not public.can_admin_facility(v_rec.recipient_facility_id) then raise exception 'FORBIDDEN'; end if;
  update public.transfer_recommendations set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_notes = trim(p_notes)
   where id = v_rec.id;
  perform public.write_audit('recommendation.rejected', 'transfer_recommendation', v_rec.id::text, v_rec.recipient_facility_id,
    jsonb_build_object('notes', p_notes));
  return 'rejected';
end $$;

grant execute on function public.approve_recommendation(uuid, uuid, integer, integer, text), public.reject_recommendation(uuid, text) to authenticated;
