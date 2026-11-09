// Inbound channel endpoint (email parser, form, CRM). Dedupes on external_id.
// The Supabase webhook then triggers processing; we also process directly as a backup.
import { after } from "next/server";
import { z } from "zod";
import { safeEqual } from "@/lib/auth";
import { env } from "@/lib/env";
import { processTicket } from "@/lib/pipeline";
import { db } from "@/lib/supabase";

export const maxDuration = 60;

const Body = z.object({
  external_id: z.string().min(1).max(200),
  channel: z.string().max(40).default("email"),
  sender_email: z.string().email().max(320).optional(),
  subject: z.string().max(300).optional(),
  body: z.string().max(20_000),
});

export async function POST(req: Request) {
  if (!safeEqual(req.headers.get("x-webhook-secret"), env.webhookSecret())) {
    return new Response("unauthorized", { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues }, { status: 400 });

  const { data, error } = await db()
    .from("tickets")
    .upsert(parsed.data, { onConflict: "external_id", ignoreDuplicates: true })
    .select("id");
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const id = data?.[0]?.id as string | undefined;
  if (!id) return Response.json({ duplicate: true });

  after(() => processTicket(id).catch((e) => console.error("processTicket", id, e)));
  return Response.json({ accepted: id }, { status: 202 });
}
