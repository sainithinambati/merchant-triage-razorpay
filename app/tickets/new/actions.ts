"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { processTicket } from "@/lib/pipeline";
import { db, logEvent } from "@/lib/supabase";
import { currentAgent } from "@/lib/ui";

export async function createTestTicket(_: { error?: string }, form: FormData): Promise<{ error?: string }> {
  const body = String(form.get("body") || "");
  const subject = String(form.get("subject") || "") || null;
  const sender_email = String(form.get("sender_email") || "").trim() || null;
  if (body.length > 20_000) return { error: "Message is too long" };
  const agent = await currentAgent();

  const { data, error } = await db()
    .from("tickets")
    .insert({ external_id: `test-${crypto.randomUUID()}`, channel: "test", subject, body, sender_email })
    .select("id")
    .single();
  if (error || !data) return { error: error?.message ?? "Insert failed" };

  await logEvent(data.id, "received", "test_ticket", { created_by: agent }, agent);
  // The Supabase webhook will also fire; the atomic claim makes sure only one run wins.
  after(() => processTicket(data.id).catch((e) => console.error("processTicket", data.id, e)));
  redirect(`/tickets/${data.id}`);
}
