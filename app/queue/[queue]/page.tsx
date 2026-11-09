import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { db } from "@/lib/supabase";
import type { Ticket } from "@/lib/types";
import { ago, QUEUES, QueueBadge, RiskBadge, slaLabel, StatusBadge } from "@/lib/ui";

export default async function QueuePage({
  params,
  searchParams,
}: {
  params: Promise<{ queue: string }>;
  searchParams: Promise<{ show?: string }>;
}) {
  await connection();
  const { queue } = await params;
  const { show } = await searchParams;
  const meta = QUEUES.find((q) => q.key === queue);
  if (!meta && queue !== "all") notFound();
  const showClosed = show === "closed";

  let q = db().from("tickets").select("*").order("created_at", { ascending: false }).limit(200);
  if (queue !== "all") q = q.eq("queue", queue);
  q = showClosed ? q.in("status", ["sent", "rejected", "info_requested"]) : q.not("status", "in", "(sent,rejected,info_requested)");
  const { data, error } = await q;
  const rows = (data ?? []) as Ticket[];
  // Most urgent first: overdue SLA, then high risk.
  if (!showClosed) rows.sort((a, b) => (a.sla_due_at ?? "9") .localeCompare(b.sla_due_at ?? "9"));

  return (
    <>
      <h1>{meta?.label ?? "All tickets"}</h1>
      <p className="sub">{meta?.hint ?? "Every queue"}</p>
      {(
        <div className="tabs">
          <Link className={!showClosed ? "on" : ""} href={`/queue/${queue}`}>Open</Link>
          <Link className={showClosed ? "on" : ""} href={`/queue/${queue}?show=closed`}>Closed</Link>
        </div>
      )}
      {error && <div className="alert">{error.message}</div>}
      <div className="panel">
        {rows.length === 0 ? <div className="empty">Nothing here.</div> : (
          <table>
            <thead><tr><th>Ticket</th><th>Merchant</th><th>Queue</th><th>Status</th><th>SLA</th><th>Received</th></tr></thead>
            <tbody>
              {rows.map((t) => {
                const sla = slaLabel(t.sla_due_at, t.status);
                return (
                  <tr key={t.id}>
                    <td className="clip">
                      <Link href={`/tickets/${t.id}`}>{t.subject || t.body.slice(0, 80)}</Link>
                      <div className="note">{t.reason}</div>
                    </td>
                    <td>{t.merchant_id ?? <span className="note">none</span>}<div className="note">{t.assigned_team ?? ""}</div></td>
                    <td><QueueBadge queue={t.queue} /> <RiskBadge risk={t.risk} /></td>
                    <td><StatusBadge status={t.status} /></td>
                    <td>{sla && <span className={`badge ${sla.overdue ? "b-bad" : "b-muted"}`}>{sla.text}</span>}</td>
                    <td className="note">{ago(t.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
