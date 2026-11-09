import "server-only";
import { claudeClassify, claudeRephrase, claudeThreatCheck } from "../claude";
import { todayISO } from "../dates";
import { env } from "../env";
import { db, logEvent } from "../supabase";
import type { Decision, FactSheet, KbRule, Merchant, Queue, Ticket, TicketStatus } from "../types";
import { decide, resolveOwnership } from "./decide";
import { extractIds, regexThreats, sanitize } from "./extract";
import { checkOutput } from "./outputCheck";
import { templateReply } from "./templates";

const MAX_ATTEMPTS = 3;
// Nothing is emailed automatically. "auto" = ready to send as written; an agent still
// sends it from their own mailbox and clicks "Mark as sent".
const SLA_HOURS: Record<Queue, number> = { auto: 2, drafts: 4, info: 2, specialist: 24, security: 1, human: 4 };

const statusFor = (q: Queue): TicketStatus =>
  q === "specialist" || q === "security" ? "escalated" : "awaiting_approval";

const slaFrom = (q: Queue) => new Date(Date.now() + SLA_HOURS[q] * 3600_000).toISOString();

/** Process one ticket end to end. Safe to call more than once: the claim is atomic. */
export async function processTicket(ticketId: string): Promise<void> {
  const supabase = db();

  // Atomic claim. Zero rows = someone else has it, it is done, or it ran out of attempts.
  const { data: claimed, error: claimErr } = await supabase.rpc("claim_ticket", { p_id: ticketId, p_max_attempts: MAX_ATTEMPTS });
  if (claimErr) throw new Error(`claim failed: ${claimErr.message}`);
  const ticket = (claimed as Ticket[] | null)?.[0];
  if (!ticket) return;
  await logEvent(ticket.id, "claim", "ok", { attempt: ticket.attempts });

  try {
    await run(ticket);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const final = ticket.attempts >= MAX_ATTEMPTS;
    await supabase
      .from("tickets")
      .update(
        final
          ? { status: "failed", queue: "human", last_error: msg, reason: "Pipeline failed 3 times; needs a human", sla_due_at: slaFrom("human") }
          : { status: "received", last_error: msg, locked_at: null },
      )
      .eq("id", ticket.id);
    await logEvent(ticket.id, "error", final ? "failed_final" : "will_retry", { message: msg, attempt: ticket.attempts });
  }
}

async function run(ticket: Ticket) {
  const supabase = db();
  const today = todayISO(env.pipelineToday());

  // 1. Extract IDs from raw text (before masking).
  const extracted = extractIds(`${ticket.subject ?? ""}\n${ticket.body}`);
  await logEvent(ticket.id, "extract_ids", "ok", { ...extracted });

  // 2. Sanitize.
  const { masked, truncated, empty, sensitive } = sanitize(`${ticket.subject ? `Subject: ${ticket.subject}\n` : ""}${ticket.body}`);
  await logEvent(ticket.id, "sanitize", empty ? "empty" : "ok", { truncated, sensitive });
  if (empty) {
    return finish(ticket, { queue: "human", reason: "Empty ticket", extracted });
  }

  // 3. Threat check: regex first, then Claude. Fails closed.
  const regexHits = regexThreats(ticket.body);
  let threat: { regex: string[]; claude: unknown } = { regex: regexHits, claude: null };
  try {
    const c = await claudeThreatCheck(masked);
    threat = { regex: regexHits, claude: c };
    if (regexHits.length || c.is_threat) {
      await logEvent(ticket.id, "threat_check", "blocked", threat);
      return finish(ticket, { queue: "security", team: "Security", reason: `Threat check: ${c.is_threat ? c.kind : "regex match"}`, extracted, threat, risk: "high" });
    }
  } catch (e) {
    await logEvent(ticket.id, "threat_check", "error_fail_closed", { message: String(e) });
    return finish(ticket, { queue: "security", team: "Security", reason: "Threat check unavailable (failed closed)", extracted, threat, risk: "high" });
  }
  await logEvent(ticket.id, "threat_check", "pass", threat);

  // 4. Classify (schema-validated, retried inside). Failure -> human.
  let classification;
  try {
    classification = await claudeClassify(masked);
  } catch (e) {
    await logEvent(ticket.id, "classify", "error", { message: String(e) });
    return finish(ticket, { queue: "human", reason: "Classifier failed after retries", extracted, threat });
  }
  await logEvent(ticket.id, "classify", "ok", { ...classification });

  // 5. Merchant + ownership.
  const claimedId = extracted.merchant_ids.length === 1 ? extracted.merchant_ids[0] : null;
  const byId = claimedId
    ? await supabase.from("merchants").select("*").eq("merchant_id", claimedId).maybeSingle()
    : { data: null, error: null };
  if (byId.error) throw new Error(`merchant lookup: ${byId.error.message}`);
  const { ownership, merchant } = resolveOwnership({ extracted, merchantById: byId.data as Merchant | null });
  await logEvent(ticket.id, "merchant_lookup", ownership, { merchant_id: merchant?.merchant_id ?? claimedId });

  // 6. Decision engine (code).
  const decision = decide({ classification, merchant, ownership, extracted, today, sensitive, truncated });
  await logEvent(ticket.id, "decision", decision.action, { ...decision });

  // 7. KB snapshot: read-only. The exact guidance text used is saved in the ticket's fact sheet.
  const { data: kbRows, error: kbErr } = await supabase
    .from("kb_rules").select("kb_id, topic, guidance").in("kb_id", decision.kb_ids);
  if (kbErr) throw new Error(`kb read: ${kbErr.message}`);
  const kb = (kbRows ?? []) as KbRule[];
  const missingKb = decision.kb_ids.filter((id) => !kb.some((r) => r.kb_id === id));
  if (missingKb.length) {
    await logEvent(ticket.id, "kb_load", "missing", { missingKb });
    return finish(ticket, { queue: "human", reason: `KB rule missing from kb_rules: ${missingKb.join(", ")}`, extracted, threat, classification, merchant, ownership, decision });
  }

  const sheet: FactSheet = {
    facts: { ...decision.facts },
    guidance: kb.map((r) => ({ kb_id: r.kb_id, text: r.guidance })),
    must_not: decision.must_not,
    forbidden_terms: decision.forbidden_terms,
    ask_for: decision.ask_for,
    language: classification.language,
  };

  // 8. Reply: template for sensitive / ask-info cases, Claude otherwise.
  let draft: string;
  let usedTemplate = decision.use_template;
  if (decision.use_template) {
    draft = templateReply(decision, sheet);
  } else {
    try {
      draft = await claudeRephrase(masked, sheet);
    } catch (e) {
      await logEvent(ticket.id, "rephrase", "error", { message: String(e) });
      draft = templateReply({ ...decision, action: "human" }, sheet);
      usedTemplate = true;
    }
  }
  await logEvent(ticket.id, "rephrase", usedTemplate ? "template" : "claude", { draft });

  // 9. Output check; on failure use the fallback template and force approval.
  const check = checkOutput(draft, sheet, decision.forbidden_terms);
  await logEvent(ticket.id, "output_check", check.passed ? "pass" : "fail", { ...check });
  let queue = decision.queue;
  let reason = decision.reason;
  if (!check.passed) {
    draft = templateReply({ ...decision, action: "reply" }, sheet);
    if (queue === "auto") queue = "drafts";
    reason += " | output check failed, template used";
  }

  return finish(ticket, {
    queue, reason, extracted, threat, classification, merchant, ownership, decision, sheet, kb, draft, check,
    team: decision.team, risk: decision.risk,
  });
}

interface FinishArgs {
  queue: Queue;
  reason: string;
  team?: string | null;
  risk?: string;
  extracted?: unknown;
  threat?: unknown;
  classification?: unknown;
  merchant?: Merchant | null;
  ownership?: string;
  decision?: Decision;
  sheet?: FactSheet;
  kb?: KbRule[];
  draft?: string;
  check?: unknown;
}

async function finish(ticket: Ticket, a: FinishArgs) {
  const supabase = db();
  const status = statusFor(a.queue);
  const update: Record<string, unknown> = {
    status,
    queue: a.queue,
    assigned_team: a.team ?? null,
    risk: a.risk ?? a.decision?.risk ?? "medium",
    reason: a.reason,
    extracted: a.extracted ?? null,
    threat: a.threat ?? null,
    classification: a.classification ?? null,
    language: (a.classification as { language?: string } | undefined)?.language ?? null,
    confidence: (a.classification as { confidence?: number } | undefined)?.confidence ?? null,
    merchant_id: a.merchant?.merchant_id ?? null,
    ownership: a.ownership ?? null,
    kb_ids: a.decision?.kb_ids ?? null,
    fact_sheet: a.sheet ?? null,
    draft_reply: a.draft ?? null,
    output_check: a.check ?? null,
    send_mode: a.queue === "auto" ? "ready_to_send" : a.queue,
    sla_due_at: slaFrom(a.queue),
    locked_at: null,
  };
  const { error } = await supabase.from("tickets").update(update).eq("id", ticket.id);
  if (error) throw new Error(`ticket update: ${error.message}`);
  await logEvent(ticket.id, "route", a.queue, { reason: a.reason, team: a.team ?? null, status });
}

export interface EmailOut { to: string; subject: string; body: string }

/** Record that an agent emailed the reply from their own mailbox. No email is sent by the app. */
export async function markSent(ticketId: string, email: EmailOut, actor: string, finalStatus: TicketStatus) {
  const { error } = await db()
    .from("tickets")
    .update({ status: finalStatus, final_reply: email.body, sent_at: new Date().toISOString(), approved_by: actor })
    .eq("id", ticketId);
  if (error) return { ok: false as const, error: error.message };
  await logEvent(ticketId, "email_sent_by_agent", finalStatus, { to: email.to, subject: email.subject, length: email.body.length }, actor);
  return { ok: true as const };
}
