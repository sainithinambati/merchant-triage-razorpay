# Merchant support triage

Next.js app on Vercel + Supabase + Claude. It takes merchant tickets, runs them through the triage pipeline, and gives agents a dashboard to approve drafts and work the escalation queues.

## Pipeline

1. **Ticket received**: a row is inserted into `tickets` (from `POST /api/tickets`, or directly), and a Supabase trigger calls `POST /api/webhook`.
2. **Atomic claim** (`claim_ticket` RPC): only one worker can process a ticket. Duplicate webhooks do nothing.
3. **Return 200**, then process in the background (`after()`).
4. **Extract IDs** with code, on the raw text, before masking.
5. **Sanitize**: mask emails, phone numbers, PAN, card and account numbers.
6. **Threat check**: regex + Claude. If Claude is unreachable, the ticket goes to Security (fails closed).
7. **Classify** with Claude (schema-validated, retried). On failure, the ticket goes to a human.
8. **Merchant + ownership check**: sender email vs `registered_email`. Mismatch goes to Security; a missing or unknown ID gets an ask-for-info reply.
9. **Decision engine** (code, `lib/pipeline/decide.ts`): picks the KB rules, facts, queue and team.
10. **KB snapshot**: published rules only, read-only, version pinned on the ticket.
11. **Rephrase**: Claude writes from the fact sheet only. KB-15 and ask-for-info cases use fixed templates.
12. **Output check** (code): dates, amounts and timelines must come from the facts or KB; blocks promises, fault, links, PII and other merchants' IDs. On failure: template + forced approval.
13. **Send mode**: auto, drafts, specialist, security, info or human. Agent edits are re-checked before sending.
14. **Audit**: every stage writes a row to `ticket_events`.

A sweeper (`/api/cron/sweeper`, every 5 minutes) retries tickets stuck in `received`/`processing` and gives up after 3 attempts.

## Setup

### 1. Supabase
Create a project (region: Mumbai, `ap-south-1`). In **SQL Editor**, run in order:
1. `supabase/schema.sql`
2. `supabase/seed_kb.sql`
3. `supabase/seed_merchants.sql` (sample data; `registered_email` values are test placeholders)

Copy from **Project Settings > API**: the Project URL and the `service_role` key.

### 2. Vercel environment variables
Project `merchant-triage` > Settings > Environment Variables:

| Key | Value |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key (mark Sensitive) |
| `ANTHROPIC_API_KEY` | your Claude API key (mark Sensitive) |
| `DASHBOARD_USERS` | `name:password,name2:password2` |
| `WEBHOOK_SECRET`, `CRON_SECRET` | already set |
| `PIPELINE_TODAY` | set to `2026-09-30` for the sample data; delete for real data |

Then redeploy.

### 3. Wire Supabase to the app
Paste the two secrets into `supabase/wiring.sql` (the app URL is already filled in) and run it. It creates the insert trigger (via `pg_net`) and the 5-minute sweeper (via `pg_cron`). Secrets are stored in Supabase Vault.

## KB rules
`kb_rules` is read-only for the app: writes from the API roles are revoked and blocked by a trigger. Edit rules in the Supabase Table Editor. Every edit bumps `version` and is copied to `kb_rules_history`. Set `status = 'draft'` to take a rule out of use.

## Local development
```
cp .env.example .env.local   # fill in
npm install
npm test                      # pipeline logic tests
npm run dev
```
