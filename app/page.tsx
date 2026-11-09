import Link from "next/link";
import { connection } from "next/server";
import { db } from "@/lib/supabase";
import type { Ticket } from "@/lib/types";
import { ago, QUEUES, QueueBadge, slaLabel, StatusBadge } from "@/lib/ui";

export default async function Overview() {
  await connection();
  const supabase = db();
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [{ data: all }, { data: recent }] = await Promise.all([
    supabase.from("tickets").select("id,status,queue,sla_due_at,kb_ids,created_at").gte("created_at", since).limit(5000),
    supabase.from("tickets").select("*").order("created_at", { ascending: false }).limit(15),
  ]);
  const rows = (all ?? []) as Pick<Ticket, "id" | "status" | "queue" | "sla_due_at" | "kb_ids" | "created_at">[];
  const open = rows.filter((r) => !["sent", "rejected"].includes(r.status));
  const overdue = open.filter((r) => slaLabel(r.sla_due_at, r.status)?.overdue).length;
  const readyNoEdit = rows.filter((r) => r.queue === "auto").length;
  const sent = rows.filter((r) => r.status === "sent" || r.status === "info_requested").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const stuck = rows.filter((r) => ["received", "processing"].includes(r.status)).length;
  const byQueue = (q: string) => rows.filter((r) => r.queue === q).length;
  const kbCounts = new Map<string, number>();
  for (const r of rows) for (const k of r.kb_ids ?? []) if (k !== "KB-16") kbCounts.set(k, (kbCounts.get(k) ?? 0) + 1);
  const topKb = [...kbCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  return (
    <>
      <h1>Overview</h1>
      <p className="sub">Last 7 days</p>
      <div className="cards">
        <div className="card"><div className="n">{rows.length}</div><div className="l">Tickets received</div></div>
        <div className="card"><div className="n">{open.length}</div><div className="l">Open</div></div>
        <div className="card"><div className="n" style={{ color: overdue ? "var(--bad)" : undefined }}>{overdue}</div><div className="l">Past SLA</div></div>
        <div className="card"><div className="n">{rows.length ? Math.round((readyNoEdit / rows.length) * 100) : 0}%</div><div className="l">Ready without edits</div></div>
        <div className="card"><div className="n">{sent}</div><div className="l">Emails sent</div></div>
        <div className="card"><div className="n" style={{ color: failed ? "var(--bad)" : undefined }}>{failed}</div><div className="l">Pipeline failures</div></div>
        <div className="card"><div className="n">{stuck}</div><div className="l">In flight</div></div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Recent tickets</h2>
          {(recent ?? []).length === 0 ? (
            <div className="empty">No tickets yet. <Link href="/tickets/new">Create a test ticket</Link>.</div>
          ) : (
            <table>
              <thead><tr><th>Ticket</th><th>Queue</th><th>Status</th><th>When</th></tr></thead>
              <tbody>
                {(recent as Ticket[]).map((t) => (
                  <tr key={t.id}>
                    <td className="clip"><Link href={`/tickets/${t.id}`}>{t.subject || t.body.slice(0, 70)}</Link><div className="note">{t.merchant_id ?? "no merchant"} · {t.reason ?? ""}</div></td>
                    <td><QueueBadge queue={t.queue} /></td>
                    <td><StatusBadge status={t.status} /></td>
                    <td className="note">{ago(t.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <div className="panel">
            <h2>Routing mix</h2>
            <table><tbody>
              {QUEUES.map((q) => (
                <tr key={q.key}><td><Link href={`/queue/${q.key}`}>{q.label}</Link><div className="note">{q.hint}</div></td><td className="num">{byQueue(q.key)}</td></tr>
              ))}
            </tbody></table>
          </div>
          <div className="panel">
            <h2>Most used KB rules</h2>
            {topKb.length === 0 ? <div className="note">No data yet</div> : (
              <table><tbody>{topKb.map(([k, n]) => <tr key={k}><td>{k}</td><td className="num">{n}</td></tr>)}</tbody></table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
