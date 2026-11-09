-- Merchant support triage: schema (matches the live Supabase project).
-- merchants and kb_rules have exactly the columns of the Excel sheets.
-- Run once, then seed_merchants.sql (and seed_kb.sql only if you want the sheet's rules loaded).

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------
-- Merchants: the Merchants_P1.xlsx columns, nothing added
-- ---------------------------------------------------------------
create table if not exists public.merchants (
  merchant_id                   text primary key,
  business_name                 text not null,
  segment                       text check (segment in ('Small','Mid','Enterprise')),
  industry                      text,
  city                          text,
  last_settlement_date          date,
  last_settlement_amount_inr    bigint,
  settlement_status             text check (settlement_status in ('Settled','Delayed','On hold')),
  hold_reason                   text check (hold_reason in ('Bank-side delay','Risk review','KYC pending','Chargeback reserve','Bank account mismatch')),
  hold_since                    date,
  expected_settlement_date      date,
  payment_success_rate_7d_pct   numeric(5,2),
  open_chargebacks              int not null default 0,
  refunds_in_process            int not null default 0,
  kyc_status                    text check (kyc_status in ('Verified','Pending','Re-verification needed')),
  gst_invoice_available         text check (gst_invoice_available in ('Yes','No'))
);

-- ---------------------------------------------------------------
-- KB rules: the KB sheet columns. Humans edit; the app can only read.
-- ---------------------------------------------------------------
create table if not exists public.kb_rules (
  kb_id     text primary key,
  topic     text not null,
  guidance  text not null
);

-- Separate audit table: the previous text of every edited or deleted rule.
create table if not exists public.kb_rules_history (
  id          bigserial primary key,
  kb_id       text not null,
  topic       text,
  guidance    text,
  changed_by  text,
  changed_at  timestamptz not null default now()
);

create or replace function public.kb_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('service_role','authenticated','anon') then
    raise exception 'kb_rules is read-only for the application (role %)', current_user;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    insert into public.kb_rules_history (kb_id, topic, guidance, changed_by)
    values (old.kb_id, old.topic, old.guidance, current_user);
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists kb_guard on public.kb_rules;
create trigger kb_guard before insert or update or delete on public.kb_rules
for each row execute function public.kb_guard();

revoke insert, update, delete, truncate on public.kb_rules from anon, authenticated, service_role;
revoke insert, update, delete, truncate on public.kb_rules_history from anon, authenticated, service_role;
grant select on public.kb_rules, public.kb_rules_history to service_role;

-- ---------------------------------------------------------------
-- Tickets: the app's own working table; status is the state machine
-- ---------------------------------------------------------------
create table if not exists public.tickets (
  id              uuid primary key default gen_random_uuid(),
  external_id     text unique,
  channel         text not null default 'email',
  sender_email    text,
  subject         text,
  body            text not null,
  status          text not null default 'received' check (status in
                    ('received','processing','awaiting_approval','info_requested','escalated','sent','rejected','failed')),
  queue           text check (queue in ('auto','drafts','specialist','security','info','human')),
  assigned_team   text,
  attempts        int  not null default 0,
  locked_at       timestamptz,
  language        text,
  extracted       jsonb,
  threat          jsonb,
  classification  jsonb,
  merchant_id     text references public.merchants(merchant_id),
  ownership       text,
  kb_ids          text[],
  fact_sheet      jsonb,
  draft_reply     text,
  final_reply     text,
  output_check    jsonb,
  send_mode       text,
  risk            text,
  confidence      numeric(4,3),
  reason          text,
  last_error      text,
  approved_by     text,
  sla_due_at      timestamptz,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists tickets_status_idx on public.tickets (status, queue, created_at desc);
create index if not exists tickets_merchant_idx on public.tickets (merchant_id);

create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists tickets_touch on public.tickets;
create trigger tickets_touch before update on public.tickets
for each row execute function public.touch_updated_at();

create table if not exists public.ticket_events (
  id         bigserial primary key,
  ticket_id  uuid not null references public.tickets(id) on delete cascade,
  stage      text not null,
  outcome    text,
  detail     jsonb,
  actor      text not null default 'pipeline',
  created_at timestamptz not null default now()
);
create index if not exists ticket_events_ticket_idx on public.ticket_events (ticket_id, id);

-- Atomic claim: only one worker can move a ticket into processing.
create or replace function public.claim_ticket(p_id uuid, p_max_attempts int default 3)
returns setof public.tickets language sql set search_path = public as $$
  update public.tickets
     set status = 'processing', attempts = attempts + 1, locked_at = now(), last_error = null
   where id = p_id
     and attempts < p_max_attempts
     and (status = 'received'
          or (status = 'processing' and locked_at < now() - interval '5 minutes'))
  returning *;
$$;

create or replace function public.stuck_tickets(p_limit int default 20)
returns setof public.tickets language sql stable set search_path = public as $$
  select * from public.tickets
   where (status = 'received'   and created_at < now() - interval '2 minutes')
      or (status = 'processing' and locked_at  < now() - interval '5 minutes')
   order by created_at
   limit p_limit;
$$;

revoke execute on function public.claim_ticket(uuid, int) from public, anon, authenticated;
revoke execute on function public.stuck_tickets(int) from public, anon, authenticated;
grant execute on function public.claim_ticket(uuid, int), public.stuck_tickets(int) to service_role;

-- Row level security: nothing readable with the anon key. The server uses the service role key.
alter table public.merchants        enable row level security;
alter table public.kb_rules         enable row level security;
alter table public.kb_rules_history enable row level security;
alter table public.tickets          enable row level security;
alter table public.ticket_events    enable row level security;
