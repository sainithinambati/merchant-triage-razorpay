export type TicketStatus =
  | "received" | "processing" | "awaiting_approval" | "info_requested"
  | "escalated" | "sent" | "rejected" | "failed";

export type Queue = "auto" | "drafts" | "specialist" | "security" | "info" | "human";

export interface Merchant {
  merchant_id: string;
  business_name: string;
  segment: "Small" | "Mid" | "Enterprise" | null;
  industry: string | null;
  city: string | null;
  last_settlement_date: string | null;
  last_settlement_amount_inr: number | null;
  settlement_status: "Settled" | "Delayed" | "On hold" | null;
  hold_reason: "Bank-side delay" | "Risk review" | "KYC pending" | "Chargeback reserve" | "Bank account mismatch" | null;
  hold_since: string | null;
  expected_settlement_date: string | null;
  payment_success_rate_7d_pct: number | null;
  open_chargebacks: number;
  refunds_in_process: number;
  kyc_status: "Verified" | "Pending" | "Re-verification needed" | null;
  gst_invoice_available: "Yes" | "No" | null;
}

/** Exactly the KB sheet columns. */
export interface KbRule {
  kb_id: string;
  topic: string;
  guidance: string;
}

export interface Ticket {
  id: string;
  external_id: string | null;
  channel: string;
  sender_email: string | null;
  subject: string | null;
  body: string;
  status: TicketStatus;
  queue: Queue | null;
  assigned_team: string | null;
  attempts: number;
  locked_at: string | null;
  language: string | null;
  extracted: Extracted | null;
  threat: unknown;
  classification: Classification | null;
  merchant_id: string | null;
  ownership: string | null;
  kb_ids: string[] | null;
  fact_sheet: FactSheet | null;
  draft_reply: string | null;
  final_reply: string | null;
  output_check: OutputCheckResult | null;
  send_mode: string | null;
  risk: string | null;
  confidence: number | null;
  reason: string | null;
  last_error: string | null;
  approved_by: string | null;
  sla_due_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Extracted {
  merchant_ids: string[];
  payment_ids: string[];
  order_ids: string[];
  refund_ids: string[];
  amounts_rupees: number[];
}

export const INTENTS = [
  "settlement_status", "payment_failure", "refund", "chargeback", "fees_invoice",
  "kyc", "account_change", "api_error", "webhook", "api_keys", "account_closure",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];

export const SENSITIVE_FLAGS = [
  "legal_threat", "media_threat", "regulator_complaint", "data_security_claim",
  "staff_fraud_or_bribery", "account_takeover", "phishing_report",
] as const;
export type SensitiveFlag = (typeof SENSITIVE_FLAGS)[number];

export interface Classification {
  intent: Intent;
  secondary_intents: Intent[];
  language: "english" | "hinglish" | "other";
  sensitive_flags: SensitiveFlag[];
  asks_waiver_or_pricing: boolean;
  change_target: "email" | "mobile" | "bank_account" | "legal_name" | "business_type" | "none";
  confidence: number;
  summary: string;
}

export interface FactSheet {
  facts: Record<string, string>;
  guidance: { kb_id: string; text: string }[];
  must_not: string[];
  forbidden_terms?: string[];
  ask_for: string[];
  language: string;
}

export interface Decision {
  action: "reply" | "ask_info" | "escalate" | "human";
  kb_ids: string[];
  facts: Record<string, string>;
  must_not: string[];        // instructions for the rephrase step
  forbidden_terms: string[]; // literal terms the output check blocks
  ask_for: string[];
  queue: Queue;
  team: string | null;
  risk: "low" | "medium" | "high";
  auto_allowed: boolean;
  use_template: boolean;   // true = never let Claude write this reply
  reason: string;
}

export interface OutputCheckResult {
  passed: boolean;
  blocking: string[];
  warnings: string[];
}
