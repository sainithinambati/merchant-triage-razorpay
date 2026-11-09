import Link from "next/link";
import { connection } from "next/server";
import { fmtDate, fmtRupees } from "@/lib/dates";
import { db } from "@/lib/supabase";
import type { Merchant } from "@/lib/types";

const FILTERS: Record<string, { label: string; apply: (m: Merchant) => boolean }> = {
  all: { label: "All", apply: () => true },
  hold: { label: "On hold", apply: (m) => m.settlement_status === "On hold" },
  delayed: { label: "Delayed", apply: (m) => m.settlement_status === "Delayed" },
  lowsr: { label: "Success rate below 85%", apply: (m) => (m.payment_success_rate_7d_pct ?? 100) < 85 },
  kyc: { label: "KYC not verified", apply: (m) => m.kyc_status !== "Verified" },
};

export default async function MerchantsPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  await connection();
  const { f = "all" } = await searchParams;
  const filter = FILTERS[f] ?? FILTERS.all;
  const { data, error } = await db().from("merchants").select("*").order("merchant_id");
  const rows = ((data ?? []) as Merchant[]).filter(filter.apply);
  return (
    <>
      <h1>Merchants</h1>
      <p className="sub">Source data for the fact sheet. {rows.length} shown.</p>
      <div className="tabs">
        {Object.entries(FILTERS).map(([k, v]) => <Link key={k} className={k === f ? "on" : ""} href={`/merchants?f=${k}`}>{v.label}</Link>)}
      </div>
      {error && <div className="alert">{error.message}</div>}
      <div className="panel" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>ID</th><th>Business</th><th>Segment</th><th>Settlement</th><th>Last settled</th><th>Expected</th><th>SR 7d</th><th>CB</th><th>KYC</th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.merchant_id}>
                <td>{m.merchant_id}</td>
                <td>{m.business_name}<div className="note">{m.city}</div></td>
                <td>{m.segment}</td>
                <td>{m.settlement_status}<div className="note">{m.hold_reason ?? ""}</div></td>
                <td className="num">{fmtDate(m.last_settlement_date)}<div className="note">{fmtRupees(m.last_settlement_amount_inr)}</div></td>
                <td className="num">{fmtDate(m.expected_settlement_date)}</td>
                <td className="num" style={{ color: (m.payment_success_rate_7d_pct ?? 100) < 85 ? "var(--bad)" : undefined }}>{m.payment_success_rate_7d_pct}%</td>
                <td className="num">{m.open_chargebacks}</td>
                <td>{m.kyc_status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
