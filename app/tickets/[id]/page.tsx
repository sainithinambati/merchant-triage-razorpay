import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/lib/supabase";
import type { Merchant, Ticket } from "@/lib/types";
import { fmtDate, fmtRupees } from "@/lib/dates";
import { fmtTime, QueueBadge, QUEUES, RiskBadge, slaLabel, StatusBadge } from "@/lib/ui";
import { closeTicket, moveTicket, reprocess } from "./actions";
import EmailComposer from "./EmailComposer";

interface Event { id: number; stage: string; outcome: string | null; detail: Record<string, unknown> | null; actor: string; created_at: string }

export default async function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = db();
  const [{ data: t }, { data: events }] = await Promise.all([
    supabase.from("tickets").select("*").eq("id", id).maybeSingle(),
    supabase.from("ticket_events").select("*").eq("ticket_id", id).order("id"),
  ]);
  if (!t) notFound();
  const ticket = t as Ticket;
  const { data: m } = ticket.merchant_id
    ? await supabase.from("merchants").select("*").eq("merchant_id", ticket.merchant_id).maybeSingle()
    : { data: null };
  const merchant = m as Merchant | null;
  const closed = ["sent", "rejected"].includes(ticket.status);
  const inFlight = ["received", "processing"].includes(ticket.status);
  const sla = slaLabel(ticket.sla_due_at, ticket.status);
  const sheet = ticket.fact_sheet;
  const check = ticket.output_check;
  const sentEvent = ((events ?? []) as Event[]).filter((e) => e.stage === "email_sent_by_agent").pop();
  const sentTo = sentEvent?.detail?.to as string | undefined;
  const sentSubject = sentEvent?.detail?.subject as string | undefined;

  return (
    <>
      <p className="note"><Link href={ticket.queue ? `/queue/${ticket.queue}` : "/queue/all"}>Back to queue</Link></p>
      <h1>{ticket.subject || "(no subject)"}</h1>
      <div className="row" style={{ marginTop: 6, marginBottom: 18 }}>
        <StatusBadge status={ticket.status} /> <QueueBadge queue={ticket.queue} /> <RiskBadge risk={ticket.risk} />
        {ticket.assigned_team && <span className="badge b-acc">{ticket.assigned_team}</span>}
        {sla && <span className={`badge ${sla.overdue ? "b-bad" : "b-muted"}`}>{sla.text}</span>}
        <span className="note">Received {fmtTime(ticket.created_at)} from {ticket.sender_email ?? "unknown sender"}</span>
      </div>

      {inFlight && <div className="alert warn">The pipeline is still working on this ticket (attempt {ticket.attempts}). Refresh in a few seconds.</div>}
      {ticket.last_error && <div className="alert">Last error: {ticket.last_error}</div>}

      <div className="grid2">
        <div>
          <div className="panel">
            <h2>Merchant message</h2>
            <pre className="msg">{ticket.body}</pre>
          </div>

          <div className="panel">
            <h2>{closed ? "Email sent" : ticket.queue === "auto" ? "Email ready to send" : "Email to the merchant"}</h2>
            {ticket.reason && <p className="note" style={{ marginTop: 0 }}>Routing: {ticket.reason}</p>}
            {!closed && ticket.merchant_id && (
              <div className="alert warn">Before sending, confirm that {ticket.sender_email ?? "the sender"} is a known contact for {ticket.merchant_id}. The merchant data has no contact emails, so the pipeline cannot check this.</div>
            )}
            {check && !check.passed && !closed && (
              <div className="alert warn">Claude&apos;s draft failed the output check, so a safe template was used. Blocked: {check.blocking.join("; ")}</div>
            )}
            <EmailComposer
              id={ticket.id}
              to={sentTo ?? ticket.sender_email ?? ""}
              subject={sentSubject ?? (ticket.subject ? `Re: ${ticket.subject.replace(/^re:\s*/i, "")}` : "Re: your support request")}
              draft={closed ? ticket.final_reply ?? "" : ticket.draft_reply ?? ""}
              closed={closed}
              sentNote={closed ? `${ticket.status === "rejected" ? "Closed without reply" : "Marked as sent"} ${fmtTime(ticket.sent_at ?? ticket.updated_at)}${ticket.approved_by ? ` by ${ticket.approved_by}` : ""}` : undefined}
            />
          </div>

          {!closed && (
            <div className="panel">
              <h2>Other actions</h2>
              <form action={moveTicket} className="row">
                <input type="hidden" name="id" value={ticket.id} />
                <select name="queue" defaultValue={ticket.queue ?? "drafts"} style={{ width: 180 }}>
                  {QUEUES.filter((q) => q.key !== "auto" && q.key !== "info").map((q) => <option key={q.key} value={q.key}>{q.label}</option>)}
                </select>
                <input name="team" placeholder="Team (optional)" defaultValue={ticket.assigned_team ?? ""} style={{ width: 200 }} />
                <button>Move</button>
              </form>
              <div className="row">
                <form action={reprocess}><input type="hidden" name="id" value={ticket.id} /><button>Re-run pipeline</button></form>
                <form action={closeTicket} className="row" style={{ marginTop: 0 }}>
                  <input type="hidden" name="id" value={ticket.id} />
                  <input name="note" placeholder="Reason for closing without reply" style={{ width: 260 }} />
                  <button className="danger">Close without reply</button>
                </form>
              </div>
            </div>
          )}

          <div className="panel">
            <h2>Audit trail</h2>
            <ul className="timeline">
              {((events ?? []) as Event[]).map((e) => (
                <li key={e.id}>
                  <div><strong>{e.stage.replace(/_/g, " ")}</strong> <span className="badge b-muted">{e.outcome}</span> <span className="note">by {e.actor}</span></div>
                  <div className="t">{fmtTime(e.created_at)}</div>
                  {e.detail && Object.keys(e.detail).length > 0 && (
                    <details><summary>details</summary><pre className="code">{JSON.stringify(e.detail, null, 2)}</pre></details>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div>
          <div className="panel">
            <h2>Classification</h2>
            {ticket.classification ? (
              <dl className="kv">
                <dt>Intent</dt><dd>{ticket.classification.intent}{ticket.classification.secondary_intents.length ? ` + ${ticket.classification.secondary_intents.join(", ")}` : ""}</dd>
                <dt>Confidence</dt><dd>{ticket.classification.confidence}</dd>
                <dt>Language</dt><dd>{ticket.classification.language}</dd>
                <dt>Sensitive flags</dt><dd>{ticket.classification.sensitive_flags.join(", ") || "none"}</dd>
                <dt>Summary</dt><dd>{ticket.classification.summary}</dd>
                <dt>Merchant ID</dt><dd>{ticket.ownership === "unverified" ? "found (sender not verified)" : ticket.ownership?.replace(/_/g, " ")}</dd>
                <dt>KB applied</dt><dd>{(ticket.kb_ids ?? []).join(", ")}</dd>
              </dl>
            ) : <div className="note">Not classified{ticket.threat ? " (stopped at threat check)" : ""}.</div>}
          </div>

          {sheet && (
            <div className="panel">
              <h2>Fact sheet given to Claude</h2>
              <dl className="kv">
                {Object.entries(sheet.facts).map(([k, v]) => <Fragment key={k}><dt>{k.replace(/_/g, " ")}</dt><dd>{v}</dd></Fragment>)}
              </dl>
              {sheet.must_not.length > 0 && <><label>Must not say</label><ul className="list">{sheet.must_not.map((x) => <li key={x}>{x}</li>)}</ul></>}
              <details><summary>KB guidance ({sheet.guidance.length})</summary>
                {sheet.guidance.map((g) => <p key={g.kb_id}><strong>{g.kb_id}</strong> {g.text}</p>)}
              </details>
            </div>
          )}

          {merchant && (
            <div className="panel">
              <h2>Merchant record</h2>
              <dl className="kv">
                <dt>Merchant</dt><dd>{merchant.business_name} ({merchant.merchant_id})</dd>
                <dt>Segment</dt><dd>{merchant.segment} · {merchant.industry} · {merchant.city}</dd>
                <dt>Settlement</dt><dd>{merchant.settlement_status}{merchant.hold_reason ? ` (${merchant.hold_reason})` : ""}</dd>
                <dt>Last settlement</dt><dd>{fmtDate(merchant.last_settlement_date)} · {fmtRupees(merchant.last_settlement_amount_inr)}</dd>
                {merchant.hold_since && <><dt>Hold since</dt><dd>{fmtDate(merchant.hold_since)}</dd></>}
                {merchant.expected_settlement_date && <><dt>Expected</dt><dd>{fmtDate(merchant.expected_settlement_date)}</dd></>}
                <dt>Success rate 7d</dt><dd style={{ color: (merchant.payment_success_rate_7d_pct ?? 100) < 85 ? "var(--bad)" : undefined }}>{merchant.payment_success_rate_7d_pct}%</dd>
                <dt>Chargebacks / refunds</dt><dd>{merchant.open_chargebacks} open · {merchant.refunds_in_process} in process</dd>
                <dt>KYC</dt><dd>{merchant.kyc_status}</dd>
                <dt>GST invoice available</dt><dd>{merchant.gst_invoice_available}</dd>
              </dl>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
