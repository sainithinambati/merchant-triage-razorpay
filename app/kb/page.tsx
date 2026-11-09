import { connection } from "next/server";
import { db } from "@/lib/supabase";
import type { KbRule } from "@/lib/types";

export default async function KbPage() {
  await connection();
  const { data, error } = await db().from("kb_rules").select("*").order("kb_id");
  const rules = (data ?? []) as KbRule[];
  return (
    <>
      <h1>KB rules</h1>
      <p className="sub">Read-only here. The app cannot write to this table; edit rules in the Supabase Table Editor. Every edit is copied to kb_rules_history, and each ticket stores the exact guidance text it used.</p>
      {error && <div className="alert">{error.message}</div>}
      {!error && rules.length === 0 && <div className="alert warn">No KB rules loaded yet. Until they are, tickets that need a rule go to &quot;Needs a human&quot;.</div>}
      <div className="panel">
        <table>
          <thead><tr><th>ID</th><th>Topic</th><th>Guidance</th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.kb_id}>
                <td><strong>{r.kb_id}</strong></td>
                <td>{r.topic}</td>
                <td>{r.guidance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
