import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env";

let admin: SupabaseClient | null = null;

/** Server-only client with the service role key. Never import this into a client component. */
export function db(): SupabaseClient {
  return (admin ??= createClient(env.supabaseUrl(), env.supabaseServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  }));
}

export async function logEvent(
  ticketId: string,
  stage: string,
  outcome: string,
  detail: Record<string, unknown> = {},
  actor = "pipeline",
) {
  const { error } = await db().from("ticket_events").insert({ ticket_id: ticketId, stage, outcome, detail, actor });
  if (error) console.error("audit write failed", stage, error.message);
}
