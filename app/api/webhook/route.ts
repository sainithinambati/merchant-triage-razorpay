// Supabase Database Webhook target (tickets INSERT). Responds at once, works in the background.
import { after } from "next/server";
import { safeEqual } from "@/lib/auth";
import { env } from "@/lib/env";
import { processTicket } from "@/lib/pipeline";

export const maxDuration = 60;

export async function POST(req: Request) {
  if (!safeEqual(req.headers.get("x-webhook-secret"), env.webhookSecret())) {
    return new Response("unauthorized", { status: 401 });
  }
  const payload = (await req.json().catch(() => null)) as { type?: string; table?: string; record?: { id?: string } } | null;
  const id = payload?.record?.id;
  if (payload?.table !== "tickets" || payload?.type !== "INSERT" || !id) {
    return Response.json({ ignored: true });
  }
  // The row already exists (status = received), so a crash after this point is
  // picked up by the sweeper. The claim inside processTicket is atomic.
  after(() => processTicket(id).catch((e) => console.error("processTicket", id, e)));
  return Response.json({ accepted: id });
}
