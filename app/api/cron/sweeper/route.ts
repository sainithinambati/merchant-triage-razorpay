// Retries tickets stuck in received/processing. Call every few minutes
// (Supabase pg_cron, see README) with Authorization: Bearer CRON_SECRET.
import { safeEqual } from "@/lib/auth";
import { env } from "@/lib/env";
import { processTicket } from "@/lib/pipeline";
import { db, logEvent } from "@/lib/supabase";
import type { Ticket } from "@/lib/types";

export const maxDuration = 300;

async function handler(req: Request) {
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!safeEqual(auth, env.cronSecret())) return new Response("unauthorized", { status: 401 });

  const supabase = db();
  const { data, error } = await supabase.rpc("stuck_tickets", { p_limit: 20 });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const results: Record<string, string> = {};
  for (const t of (data ?? []) as Ticket[]) {
    if (t.attempts >= 3) {
      await supabase.from("tickets")
        .update({ status: "failed", queue: "human", locked_at: null, reason: "Stuck after 3 attempts; needs a human" })
        .eq("id", t.id);
      await logEvent(t.id, "sweeper", "gave_up", { attempts: t.attempts }, "sweeper");
      results[t.id] = "gave_up";
      continue;
    }
    await logEvent(t.id, "sweeper", "retry", { attempts: t.attempts }, "sweeper");
    await processTicket(t.id).catch((e) => console.error("sweeper", t.id, e));
    results[t.id] = "retried";
  }
  return Response.json({ checked: data?.length ?? 0, results });
}

export { handler as GET, handler as POST };
