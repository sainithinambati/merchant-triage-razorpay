import { headers } from "next/headers";
import type { Queue, TicketStatus } from "./types";

export const QUEUES: { key: Queue; label: string; hint: string }[] = [
  { key: "auto", label: "Ready to send", hint: "Passed every check; agent emails it as written" },
  { key: "drafts", label: "Drafts to review", hint: "Agent edits or decides, then emails" },
  { key: "specialist", label: "Specialist", hint: "Disputes, legal, compliance" },
  { key: "security", label: "Security", hint: "Threats, takeover, bank account changes" },
  { key: "human", label: "Needs a human", hint: "No rule, low confidence, failures" },
  { key: "info", label: "Ask for info", hint: "Email asking for the merchant or payment ID" },
];

export async function currentAgent(): Promise<string> {
  return (await headers()).get("x-agent") || "unknown";
}

export function StatusBadge({ status }: { status: TicketStatus | string }) {
  const cls: Record<string, string> = {
    received: "b-muted", processing: "b-acc", awaiting_approval: "b-warn", info_requested: "b-muted",
    escalated: "b-sec", sent: "b-ok", rejected: "b-muted", failed: "b-bad",
  };
  return <span className={`badge ${cls[status] ?? "b-muted"}`}>{String(status).replace(/_/g, " ")}</span>;
}

export function QueueBadge({ queue }: { queue: string | null }) {
  if (!queue) return <span className="badge b-muted">pending</span>;
  const cls: Record<string, string> = { auto: "b-ok", drafts: "b-warn", specialist: "b-sec", security: "b-bad", human: "b-bad", info: "b-muted" };
  return <span className={`badge ${cls[queue] ?? "b-muted"}`}>{queue}</span>;
}

export function RiskBadge({ risk }: { risk: string | null }) {
  if (!risk) return null;
  const cls = risk === "high" ? "b-bad" : risk === "medium" ? "b-warn" : "b-ok";
  return <span className={`badge ${cls}`}>{risk} risk</span>;
}

export function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function slaLabel(iso: string | null, status: string): { text: string; overdue: boolean } | null {
  if (!iso || ["sent", "rejected"].includes(status)) return null;
  const mins = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (mins < 0) return { text: `overdue ${Math.abs(mins) < 120 ? `${-mins}m` : `${Math.round(-mins / 60)}h`}`, overdue: true };
  return { text: `due in ${mins < 120 ? `${mins}m` : `${Math.round(mins / 60)}h`}`, overdue: false };
}

export function fmtTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
