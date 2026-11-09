-- Run AFTER schema.sql and the seeds. Paste the two secrets marked <...> first.
-- Secrets live in Supabase Vault, not in this SQL.

create extension if not exists pg_net;
create extension if not exists pg_cron;

select vault.create_secret('https://merchant-triage.vercel.app', 'triage_app_url');
select vault.create_secret('<paste WEBHOOK_SECRET from Vercel > Settings > Environment Variables>', 'triage_webhook_secret');
select vault.create_secret('<paste CRON_SECRET from Vercel > Settings > Environment Variables>', 'triage_cron_secret');

-- 1. Ticket received -> POST /api/webhook (same payload shape as a Supabase Database Webhook)
create or replace function public.notify_ticket_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  app_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'triage_app_url');
  secret  text := (select decrypted_secret from vault.decrypted_secrets where name = 'triage_webhook_secret');
begin
  perform net.http_post(
    url     := app_url || '/api/webhook',
    body    := jsonb_build_object('type', 'INSERT', 'table', 'tickets', 'record', jsonb_build_object('id', new.id)),
    headers := jsonb_build_object('content-type', 'application/json', 'x-webhook-secret', secret),
    timeout_milliseconds := 5000
  );
  return new;
end $$;

drop trigger if exists tickets_notify on public.tickets;
create trigger tickets_notify after insert on public.tickets
for each row execute function public.notify_ticket_insert();

-- 2. Sweeper every 5 minutes (Vercel Hobby crons only run daily, so Supabase schedules it)
select cron.unschedule('triage-sweeper') where exists (select 1 from cron.job where jobname = 'triage-sweeper');
select cron.schedule('triage-sweeper', '*/5 * * * *', $$
  select net.http_get(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'triage_app_url') || '/api/cron/sweeper',
    headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'triage_cron_secret')),
    timeout_milliseconds := 5000
  );
$$);
