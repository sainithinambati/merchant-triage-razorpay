import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/supabase";
import { currentAgent, QUEUES } from "@/lib/ui";
import "./globals.css";

export const metadata: Metadata = { title: "Merchant Support Triage" };

async function openCounts(): Promise<Record<string, number>> {
  const { data } = await db()
    .from("tickets")
    .select("queue, status")
    .not("status", "in", "(sent,rejected,info_requested)")
    .limit(5000);
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[r.queue ?? "pending"] = (counts[r.queue ?? "pending"] ?? 0) + 1;
  return counts;
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const [counts, agent] = await Promise.all([openCounts().catch(() => ({}) as Record<string, number>), currentAgent()]);
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="side">
            <div className="brand">Support triage</div>
            <Link href="/"><span>Overview</span></Link>
            <Link href="/tickets/new"><span>New test ticket</span></Link>
            <div className="group">Queues (open)</div>
            {QUEUES.map((q) => (
              <Link key={q.key} href={`/queue/${q.key}`}>
                <span>{q.label}</span>
                <span className="count">{counts[q.key] ?? 0}</span>
              </Link>
            ))}
            <Link href="/queue/all"><span>All tickets</span></Link>
            <div className="group">Reference</div>
            <Link href="/kb"><span>KB rules (read-only)</span></Link>
            <Link href="/merchants"><span>Merchants</span></Link>
            <div className="who">Signed in as {agent}</div>
          </nav>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
