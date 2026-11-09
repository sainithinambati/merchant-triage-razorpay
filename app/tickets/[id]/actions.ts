"use server";

import { refresh } from "next/cache";
import { after } from "next/server";
import { markSent, processTicket } from "@/lib/pipeline";
import { checkOutput } from "@/lib/pipeline/outputCheck";
import { db, logEvent } from "@/lib/supabase";
import type { FactSheet, OutputCheckResult, Queue, Ticket } from "@/lib/types";
import { currentAgent } from "@/lib/ui";

export interface ActionState {
  ok?: string;
  error?: string;
  blocking?: string[];
  warnings?: string[];
}

const EMPTY_SHEET: FactSheet = { facts: {}, guidance: [], must_not: [], ask_for: [], language: "english" };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function load(id: string): Promise<Ticket | null> {
  const { data } = await db().from("tickets").select("*").eq("id", id).maybeSingle();
  return data as Ticket | null;
}

/** Same rule everywhere: personal data always blocks; other blocks can be overridden by a tick. */
function review(text: string, t: Ticket, override: boolean): { check: OutputCheckResult; state: ActionState | null } {
  const sheet = t.fact_sheet ?? EMPTY_SHEET;
  const check = checkOutput(text, sheet, sheet.forbidden_terms ?? []);
  const pii = check.blocking.filter((b) => /email address|phone|PAN|account number|another merchant/i.test(b));
  if (pii.length) return { check, state: { error: "Remove personal data before sending.", blocking: pii, warnings: check.warnings } };
  if (!check.passed && !override) {
    return {
      check,
      state: { error: "The reply says things the system data does not support. Fix it, or tick the override box if you have verified it.", blocking: check.blocking, warnings: check.warnings },
    };
  }
  return { check, state: null };
}

/** Called before "Copy email" and "Open in mail app": the client only proceeds if this returns ok. */
export async function checkBeforeSending(id: string, body: string, override: boolean): Promise<ActionState> {
  const t = await load(id);
  if (!t) return { error: "Ticket not found" };
  if (!body.trim()) return { error: "The email body is empty." };
  const { check, state } = review(body.trim(), t, override);
  return state ?? { ok: "Checked.", warnings: check.warnings, blocking: check.passed ? [] : check.blocking };
}

/** The agent has emailed the reply from their own mailbox; record it and close the ticket. */
export async function markAsSent(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("id"));
  const to = String(form.get("to") || "").trim();
  const subject = String(form.get("subject") || "").trim();
  const body = String(form.get("reply") || "").trim();
  const override = form.get("override") === "on";
  const agent = await currentAgent();
  const t = await load(id);
  if (!t) return { error: "Ticket not found" };
  if (["sent", "rejected"].includes(t.status)) return { error: "Ticket is already closed" };
  if (!EMAIL_RE.test(to)) return { error: "Enter the merchant's email address in To." };
  if (!body) return { error: "The email body is empty." };

  const { check, state } = review(body, t, override);
  if (state) return state;

  await db().from("tickets").update({ draft_reply: body, output_check: check }).eq("id", id);
  await logEvent(id, "agent_review", check.passed ? "approved" : "approved_with_override", { blocking: check.blocking, edited: body !== t.draft_reply }, agent);
  const res = await markSent(id, { to, subject, body }, agent, t.queue === "info" ? "info_requested" : "sent");
  refresh();
  return res.ok ? { ok: "Marked as sent." } : { error: res.error };
}

export async function saveDraft(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("id"));
  const text = String(form.get("reply") || "");
  const agent = await currentAgent();
  const t = await load(id);
  if (!t) return { error: "Ticket not found" };
  const sheet = t.fact_sheet ?? EMPTY_SHEET;
  const check = checkOutput(text, sheet, sheet.forbidden_terms ?? []);
  await db().from("tickets").update({ draft_reply: text, output_check: check }).eq("id", id);
  await logEvent(id, "agent_edit", "saved", { length: text.length }, agent);
  refresh();
  return { ok: "Draft saved.", blocking: check.blocking, warnings: check.warnings };
}

export async function closeTicket(form: FormData) {
  const id = String(form.get("id"));
  const note = String(form.get("note") || "");
  const agent = await currentAgent();
  await db().from("tickets").update({ status: "rejected", approved_by: agent }).eq("id", id);
  await logEvent(id, "agent_close", "closed_without_reply", { note }, agent);
  refresh();
}

export async function moveTicket(form: FormData) {
  const id = String(form.get("id"));
  const queue = String(form.get("queue")) as Queue;
  const team = String(form.get("team") || "") || null;
  const agent = await currentAgent();
  const status = queue === "specialist" || queue === "security" ? "escalated" : "awaiting_approval";
  await db().from("tickets").update({ queue, status, assigned_team: team }).eq("id", id);
  await logEvent(id, "agent_move", queue, { team }, agent);
  refresh();
}

/** Run the pipeline again from the start (for example after a KB edit or merchant data fix). */
export async function reprocess(form: FormData) {
  const id = String(form.get("id"));
  const agent = await currentAgent();
  await db().from("tickets").update({ status: "received", attempts: 0, locked_at: null, last_error: null }).eq("id", id);
  await logEvent(id, "agent_reprocess", "queued", {}, agent);
  after(() => processTicket(id).catch((e) => console.error("reprocess", id, e)));
  refresh();
}
