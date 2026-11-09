// Decision engine: pure code. Claude never decides what the merchant is told;
// it only rephrases the facts this function selects.
import { addBusinessDays, fmtDate, fmtRupees } from "../dates";
import type { Classification, Decision, Extracted, Intent, Merchant } from "../types";
import type { SensitiveKind } from "./extract";

export const REFUND_ESCALATION_RUPEES = 1_00_000; // KB-07
export const SUCCESS_RATE_FLOOR_PCT = 85;          // KB-06, strict "below"
export const KYC_STUCK_BUSINESS_DAYS = 5;          // KB-26 (provisional, needs confirmation)

export const SECURITY_REMINDER =
  "Please do not share OTPs, passwords, PINs, card numbers, Aadhaar or bank account numbers over email or chat. Our team will never ask for them.";

/** Intents that can be answered without looking at one merchant's records. */
const GENERIC_INTENTS: Intent[] = ["api_error", "webhook", "api_keys"];

// The merchant data has no contact emails, so the pipeline cannot prove the sender owns
// the ID. "unverified" = the ID exists; the agent confirms the sender before emailing.
export type Ownership = "unverified" | "not_found" | "missing" | "ambiguous";

export function resolveOwnership(args: {
  extracted: Extracted;
  merchantById: Merchant | null;
}): { ownership: Ownership; merchant: Merchant | null } {
  const { extracted, merchantById } = args;
  if (extracted.merchant_ids.length > 1) return { ownership: "ambiguous", merchant: null };
  if (extracted.merchant_ids.length === 0) return { ownership: "missing", merchant: null };
  if (!merchantById) return { ownership: "not_found", merchant: null };
  return { ownership: "unverified", merchant: merchantById };
}

const base = (over: Partial<Decision>): Decision => ({
  action: "reply",
  kb_ids: [],
  facts: {},
  must_not: [],
  forbidden_terms: [],
  ask_for: [],
  queue: "drafts",
  team: null,
  risk: "low",
  auto_allowed: false,
  use_template: false,
  reason: "",
  ...over,
});

interface DecideArgs {
  classification: Classification;
  merchant: Merchant | null;
  ownership: Ownership;
  extracted: Extracted;
  today: string;
  sensitive?: SensitiveKind[]; // secret data the sender pasted into the ticket
  truncated?: boolean;         // ticket longer than we read
}

/** Rules that apply on top of whatever the main rule decided. */
export function decide(args: DecideArgs): Decision {
  const d = decideCore(args);
  const notes: string[] = [];

  // KB-23: the sender pasted an OTP, password, card, Aadhaar or account number.
  const secrets = (args.sensitive ?? []).filter((k) => k !== "pan");
  if (secrets.length) {
    d.kb_ids = [...new Set([...d.kb_ids, "KB-23"])];
    d.facts = { ...d.facts, security_reminder: SECURITY_REMINDER };
    d.must_not = [...new Set([...d.must_not, "repeat any OTP, password, PIN, card, Aadhaar or account number"])];
    notes.push(`sender shared ${secrets.join(", ")} (KB-23)`);
  }
  // KB-25: language other than English or Hinglish.
  if (args.classification.language === "other") {
    d.kb_ids = [...new Set([...d.kb_ids, "KB-25"])];
    notes.push("language not English or Hinglish (KB-25)");
    if (d.queue === "auto") d.queue = "drafts";
  }
  // Long ticket: we only read the first part, so a person checks the rest.
  if (args.truncated) {
    notes.push("message too long, only the first part was read");
    if (d.queue === "auto") d.queue = "drafts";
  }
  if (d.queue !== "auto") d.auto_allowed = false;
  if (notes.length) d.reason += ` | ${notes.join("; ")}`;
  return d;
}

function decideCore(args: DecideArgs): Decision {
  const { classification: c, merchant: m, ownership, extracted, today } = args;

  // 1. KB-15 overrides everything, including a missing merchant ID.
  if (c.sensitive_flags.length > 0) {
    const securityFlags = ["account_takeover", "data_security_claim", "phishing_report"];
    const isSecurity = c.sensitive_flags.some((f) => securityFlags.includes(f));
    return base({
      action: "escalate",
      kb_ids: ["KB-15"],
      queue: isSecurity ? "security" : "specialist",
      team: isSecurity ? "Security" : "Legal & Compliance",
      risk: "high",
      use_template: true,
      reason: `KB-15 escalation: ${c.sensitive_flags.join(", ")}`,
    });
  }

  // 2. Identity problems.
  if (ownership === "ambiguous") {
    return base({
      action: "human", queue: "human", risk: "medium", use_template: true,
      reason: "Ticket mentions more than one merchant ID",
    });
  }

  // 3. Low confidence or unknown intent: a human reads it.
  if (c.intent === "other" || c.confidence < 0.7) {
    return base({
      action: "human", queue: "human", risk: "medium", use_template: true,
      reason: c.intent === "other" ? "No KB rule matches this request" : `Low classifier confidence (${c.confidence})`,
    });
  }

  // 3b. Login, password and OTP problems: no KB rule yet, so a person handles them.
  if (c.intent === "account_access") {
    return base({
      action: "human", queue: "human", risk: "medium", use_template: true,
      reason: "Login or account access issue: no KB rule yet (pending your decision)",
    });
  }

  // 3c. KB-22: the writer is a customer of a merchant, not the merchant.
  if (c.requester_type === "customer") {
    return customerRule(c, extracted);
  }

  // 4. Generic technical questions do not need merchant records.
  if (GENERIC_INTENTS.includes(c.intent) && c.secondary_intents.length === 0) {
    const kb = { api_error: "KB-12", webhook: "KB-13", api_keys: "KB-14" }[c.intent as "api_error" | "webhook" | "api_keys"];
    return base({ kb_ids: [kb, "KB-16"], queue: "auto", auto_allowed: true, reason: `Technical guidance (${kb})` });
  }

  // 5. KB-16: ask for the ID before anything else.
  if (ownership === "missing" || ownership === "not_found") {
    return base({
      action: "ask_info", kb_ids: ["KB-16"], queue: "info", use_template: true, auto_allowed: true,
      ask_for: ["merchant ID (it starts with M, shown on your Dashboard)", ...(c.intent === "payment_failure" || c.intent === "refund" ? ["payment ID (pay_...)"] : [])],
      reason: ownership === "missing" ? "Merchant ID missing" : "Merchant ID not found",
    });
  }

  const merchant = m!;
  const facts: Record<string, string> = { business_name: merchant.business_name, merchant_id: merchant.merchant_id };
  const parts: Decision[] = [];

  for (const intent of [c.intent, ...c.secondary_intents]) {
    parts.push(ruleFor(intent, merchant, c, extracted, today));
  }

  // A settlement question from a merchant whose KYC needs re-verification: point them to KB-10 too.
  if ((c.intent === "settlement_status" || c.secondary_intents.includes("settlement_status")) && merchant.kyc_status === "Re-verification needed") {
    parts.push(base({
      kb_ids: ["KB-10", "KB-24"], queue: "auto", auto_allowed: true,
      facts: { kyc_status: "Re-verification needed" },
      reason: "KYC re-verification pending (KB-10)",
    }));
  }

  // Merge: the most cautious part wins.
  const rank = { auto: 0, info: 1, drafts: 2, specialist: 3, human: 3, security: 4 } as const;
  const worst = parts.reduce((a, b) => (rank[b.queue] > rank[a.queue] ? b : a));
  const merged = base({
    action: parts.some((p) => p.action === "escalate") ? "escalate" : "reply",
    kb_ids: [...new Set([...parts.flatMap((p) => p.kb_ids), "KB-16"])],
    facts: Object.assign(facts, ...parts.map((p) => p.facts)),
    must_not: [...new Set(parts.flatMap((p) => p.must_not))],
    forbidden_terms: [...new Set(parts.flatMap((p) => p.forbidden_terms))],
    queue: worst.queue,
    team: parts.map((p) => p.team).filter(Boolean).join(", ") || null,
    risk: parts.some((p) => p.risk === "high") ? "high" : parts.some((p) => p.risk === "medium") ? "medium" : "low",
    auto_allowed: parts.every((p) => p.auto_allowed),
    use_template: parts.some((p) => p.use_template),
    reason: parts.map((p) => p.reason).join("; "),
  });

  // Guards that apply to every reply.
  const blockers: string[] = [];
  if (c.secondary_intents.length > 0) blockers.push("multi-intent");
  if (merchant.segment === "Enterprise") {
    // KB-21: an agent reviews every Enterprise reply and the Account Manager is kept informed.
    merged.kb_ids = [...new Set([...merged.kb_ids, "KB-21"])];
    merged.team = [merged.team, "Account Manager (FYI)"].filter(Boolean).join(", ");
    blockers.push("Enterprise merchant (KB-21)");
  }
  if (blockers.length && merged.queue === "auto") {
    merged.queue = "drafts";
    merged.auto_allowed = false;
    merged.reason += ` | draft because: ${blockers.join(", ")}`;
  }
  if (!merged.auto_allowed && merged.queue === "auto") merged.queue = "drafts";
  return merged;
}

function ruleFor(intent: Intent, m: Merchant, c: Classification, ex: Extracted, today: string): Decision {
  switch (intent) {
    case "settlement_status":
      return settlementRule(m, today);

    case "settlement_amount_query":
      return base({
        action: "escalate", kb_ids: ["KB-19"], queue: "drafts", team: "Account Manager", risk: "medium",
        facts: {
          last_settlement_date: fmtDate(m.last_settlement_date),
          last_settlement_amount: fmtRupees(m.last_settlement_amount_inr),
          escalated_to: "your Account Manager for reconciliation",
        },
        must_not: ["explain deductions, fees, refunds or adjustments that are not in the facts", "say the amount is correct or wrong"],
        reason: "KB-19 settlement amount query",
      });

    case "account_access":
      return base({ action: "human", queue: "human", reason: "Login or account access issue: no KB rule yet (pending your decision)" });

    case "payment_failure": {
      const rate = m.payment_success_rate_7d_pct;
      if (rate != null && rate < SUCCESS_RATE_FLOOR_PCT) {
        return base({
          action: "escalate", kb_ids: ["KB-06"], queue: "drafts", team: "Payments Ops", risk: "medium",
          facts: { escalated_to: "Payments Ops team" },
          must_not: ["blame the customer or the merchant's customers", "quote the success rate"],
          forbidden_terms: ["your customers entered", "customer error", "customer's fault"],
          reason: `KB-06: success rate ${rate}% below ${SUCCESS_RATE_FLOOR_PCT}%`,
        });
      }
      return base({ kb_ids: ["KB-06"], queue: "auto", auto_allowed: true, reason: "KB-06 payment failure guidance" });
    }

    case "refund": {
      const big = ex.amounts_rupees.some((a) => a >= REFUND_ESCALATION_RUPEES);
      const facts = { refunds_in_process: String(m.refunds_in_process) };
      if (big) {
        return base({
          action: "escalate", kb_ids: ["KB-07"], queue: "drafts", team: "Refund Ops", risk: "medium", facts,
          must_not: ["any refund timeline"],
          forbidden_terms: ["5-7", "business days", "within"],
          reason: "KB-07: refund of Rs. 1,00,000 or more goes to Refund Ops",
        });
      }
      // Amount unknown: the system has no refund amounts yet, so a human checks.
      return base({
        kb_ids: ["KB-07"], queue: ex.amounts_rupees.length ? "auto" : "drafts",
        auto_allowed: ex.amounts_rupees.length > 0, facts,
        reason: ex.amounts_rupees.length ? "KB-07 refund timeline" : "KB-07: refund amount not stated, cannot check threshold",
      });
    }

    case "chargeback":
      return base({
        kb_ids: ["KB-08"], queue: "specialist", team: "Disputes", risk: "medium",
        facts: { open_chargebacks: String(m.open_chargebacks) },
        must_not: ["say a dispute can be blocked", "predict the dispute outcome"],
        reason: "KB-08 dispute: specialist review, 7-day evidence window",
      });

    case "fees_invoice":
      if (c.asks_waiver_or_pricing) {
        return base({
          action: "escalate", kb_ids: ["KB-09"], queue: "drafts", team: "Account Manager", risk: "medium",
          must_not: ["agree to any waiver, discount or MDR change"],
          forbidden_terms: ["waived", "we will waive", "discount approved", "reduced your mdr"],
          reason: "KB-09: pricing or waiver request goes to the Account Manager",
        });
      }
      if (m.gst_invoice_available === "No") {
        return base({
          action: "escalate", kb_ids: ["KB-09", "KB-20"], queue: "drafts", team: "Account Manager", risk: "low",
          facts: { gst_invoice_available: "No" },
          must_not: ["promise a date for the missing invoice"],
          reason: "KB-20 GST invoice not available",
        });
      }
      return base({ kb_ids: ["KB-09"], queue: "auto", auto_allowed: true, facts: { gst_invoice_available: "Yes" }, reason: "KB-09 invoice location" });

    case "kyc": {
      const facts = { kyc_status: m.kyc_status ?? "unknown" };
      const stuck = isKycStuck(m, today);
      const kb = m.kyc_status === "Pending" ? ["KB-04", "KB-10", "KB-24"] : ["KB-10", "KB-24"];
      return base({
        kb_ids: stuck ? [...kb, "KB-26"] : kb, queue: stuck ? "drafts" : "auto", auto_allowed: !stuck,
        team: stuck ? "KYC team" : null, facts,
        must_not: ["ask for documents by email or reply", "share links other than the Dashboard", "promise a release date"],
        reason: stuck ? `KB-26 KYC hold pending more than ${KYC_STUCK_BUSINESS_DAYS} business days` : `KB-10 KYC (${m.kyc_status})`,
      });
    }

    case "account_change":
      if (c.change_target === "bank_account") {
        return base({
          action: "escalate", kb_ids: ["KB-11", "KB-15"], queue: "security", team: "Security", risk: "high",
          use_template: true, reason: "Bank account change requested through support (possible takeover)",
        });
      }
      return base({
        kb_ids: ["KB-11"], queue: c.change_target === "email" || c.change_target === "mobile" ? "auto" : "drafts",
        auto_allowed: c.change_target === "email" || c.change_target === "mobile",
        reason: `KB-11 account change (${c.change_target})`,
      });

    case "account_closure":
      return base({
        action: "escalate", kb_ids: ["KB-17"], queue: "drafts", team: "Account Manager, Risk Ops", risk: "medium",
        facts: {
          open_chargebacks: String(m.open_chargebacks),
          refunds_in_process: String(m.refunds_in_process),
          settlement_status: m.settlement_status ?? "unknown",
        },
        must_not: ["confirm the account is closed", "give a closure date"],
        reason: "KB-17 closure request",
      });

    case "api_error": return base({ kb_ids: ["KB-12"], queue: "auto", auto_allowed: true, reason: "KB-12" });
    case "webhook": return base({ kb_ids: ["KB-13"], queue: "auto", auto_allowed: true, reason: "KB-13" });
    case "api_keys": return base({ kb_ids: ["KB-14"], queue: "auto", auto_allowed: true, reason: "KB-14" });
    default:
      return base({ action: "human", queue: "human", reason: `No rule for ${intent}` });
  }
}

function settlementRule(m: Merchant, today: string): Decision {
  const facts: Record<string, string> = {
    settlement_status: m.settlement_status ?? "unknown",
    last_settlement_date: fmtDate(m.last_settlement_date),
    last_settlement_amount: fmtRupees(m.last_settlement_amount_inr),
  };

  if (m.settlement_status === "Settled") {
    return base({ kb_ids: ["KB-01"], queue: "auto", auto_allowed: true, facts, reason: "KB-01 settled" });
  }

  if (m.settlement_status === "Delayed") {
    const exp = m.expected_settlement_date;
    if (exp && exp >= today) {
      return base({
        kb_ids: ["KB-02"], queue: "auto", auto_allowed: true,
        facts: { ...facts, expected_settlement_date: fmtDate(exp) },
        reason: "KB-02 bank-side delay, date shown in system",
      });
    }
    // KB-18: the expected date has passed (or is missing). Never quote an old or new date.
    return base({
      action: "escalate", kb_ids: ["KB-18"], queue: "drafts", team: "Settlements team", risk: "medium",
      facts: { settlement_status: "Delayed", escalated_to: "the settlements team for priority review" },
      must_not: ["quote any settlement date", "say the settlement will arrive soon"],
      forbidden_terms: ["by tomorrow", "today itself", "shortly"],
      reason: exp ? `KB-18 delay past expected date (${fmtDate(exp)})` : "KB-18 delayed with no expected date",
    });
  }

  // On hold
  switch (m.hold_reason) {
    case "Risk review":
    case "Chargeback reserve": {
      const overdue = m.hold_reason === "Risk review" && m.hold_since && addBusinessDays(m.hold_since, 5) < today;
      return base({
        action: "escalate", kb_ids: m.hold_reason === "Chargeback reserve" ? ["KB-03", "KB-08"] : ["KB-03"],
        queue: "drafts", team: "Risk Ops", risk: "medium",
        facts: { settlement_status: "On hold", escalated_to: "the specialist team that reviews holds" },
        must_not: ["the internal reason for the hold", "any release date", "that support can release or shorten the hold"],
        forbidden_terms: ["risk", "fraud", "suspicious", "chargeback reserve", "reserve"],
        reason: `KB-03 ${m.hold_reason} hold${overdue ? " (past 5 business days)" : ""}`,
      });
    }
    case "KYC pending": {
      // KB-26 (provisional): a KYC hold older than 5 business days may be stuck, so an agent checks first.
      const stuck = isKycStuck(m, today);
      return base({
        kb_ids: stuck ? ["KB-04", "KB-10", "KB-24", "KB-26"] : ["KB-04", "KB-10", "KB-24"],
        queue: stuck ? "drafts" : "auto", auto_allowed: !stuck, team: stuck ? "KYC team" : null,
        facts: { ...facts, hold_reason: "KYC pending", kyc_status: m.kyc_status ?? "Pending" },
        reason: stuck ? `KB-26 KYC hold pending more than ${KYC_STUCK_BUSINESS_DAYS} business days` : "KB-04 KYC hold",
      });
    }
    case "Bank account mismatch":
      return base({
        kb_ids: ["KB-05"], queue: "auto", auto_allowed: true,
        facts: { ...facts, hold_reason: "Bank account name does not match registered name" },
        reason: "KB-05 bank account mismatch",
      });
    default:
      return base({ action: "human", queue: "human", facts, reason: "On hold with unknown reason" });
  }
}

/** KB-22: requests from a merchant's customer. General guidance only, never merchant data. */
function customerRule(c: Classification, ex: Extracted): Decision {
  const common = {
    must_not: ["share any merchant account, settlement or business details", "confirm or deny any specific payment"],
  };
  if (c.intent === "payment_failure") {
    return base({ ...common, kb_ids: ["KB-22", "KB-06", "KB-16"], queue: "auto", auto_allowed: true, reason: "KB-22 customer: failed payment guidance" });
  }
  if (c.intent === "refund") {
    if (ex.amounts_rupees.some((a) => a >= REFUND_ESCALATION_RUPEES)) {
      return base({
        ...common, action: "escalate", kb_ids: ["KB-22", "KB-07", "KB-16"], queue: "drafts", team: "Refund Ops", risk: "medium",
        forbidden_terms: ["5-7", "business days", "within"],
        reason: "KB-22 customer refund of Rs. 1,00,000 or more (KB-07)",
      });
    }
    return base({ ...common, kb_ids: ["KB-22", "KB-07", "KB-16"], queue: "auto", auto_allowed: true, reason: "KB-22 customer: refund guidance" });
  }
  return base({ ...common, kb_ids: ["KB-22", "KB-16"], queue: "drafts", risk: "medium", reason: `KB-22 customer request (${c.intent})` });
}

/** KB-26: a KYC hold older than KYC_STUCK_BUSINESS_DAYS business days. */
function isKycStuck(m: Merchant, today: string): boolean {
  return m.hold_reason === "KYC pending" && !!m.hold_since && addBusinessDays(m.hold_since, KYC_STUCK_BUSINESS_DAYS) < today;
}
