import type { Extracted } from "../types";

const uniq = <T,>(a: T[]) => [...new Set(a)];

/** Pull IDs and amounts from the RAW text, before any masking. Pure code, no Claude. */
export function extractIds(text: string): Extracted {
  const merchant_ids = uniq([...text.matchAll(/\bM\s?-?(\d{4})\b/gi)].map((m) => `M${m[1]}`));
  const payment_ids = uniq([...text.matchAll(/\bpay_[A-Za-z0-9]{6,}\b/g)].map((m) => m[0]));
  const order_ids = uniq([...text.matchAll(/\border_[A-Za-z0-9]{6,}\b/g)].map((m) => m[0]));
  const refund_ids = uniq([...text.matchAll(/\brfnd_[A-Za-z0-9]{6,}\b/g)].map((m) => m[0]));
  const amounts_rupees = uniq(
    [...text.matchAll(/(?:rs\.?|inr|₹)\s?([\d,]+(?:\.\d{1,2})?)\s*(lakh|lac|k)?/gi)]
      .map((m) => {
        let n = Number(m[1].replace(/,/g, ""));
        const unit = (m[2] || "").toLowerCase();
        if (unit === "k") n *= 1_000;
        if (unit === "lakh" || unit === "lac") n *= 1_00_000;
        return n;
      })
      .filter((n) => Number.isFinite(n) && n > 0),
  );
  return { merchant_ids, payment_ids, order_ids, refund_ids, amounts_rupees };
}

const MAX_CHARS = 4000;

export type SensitiveKind = "secret_code" | "card_number" | "aadhaar" | "bank_account" | "pan";

/**
 * Mask PII before anything is sent to Claude. IDs are kept: they are not personal data.
 * `sensitive` lists the kinds of secret data the merchant shared, so the reply can warn them (KB-23).
 */
export function sanitize(text: string): { masked: string; truncated: boolean; empty: boolean; sensitive: SensitiveKind[] } {
  const trimmed = text.replace(/\u0000/g, "").trim();
  const truncated = trimmed.length > MAX_CHARS;
  const found = new Set<SensitiveKind>();
  let s = trimmed.slice(0, MAX_CHARS);
  // OTPs, passwords, PINs, CVVs: mask the value that follows the keyword when it looks like a code.
  s = s.replace(/\b(otp|one[- ]time password|password|passcode|upi pin|m?pin|cvv)\b(\s*(?:is|:|-|=)?\s*)([^\s,.;]{3,})/gi, (m, k, sep, v) => {
    if (!/\d/.test(v) && v.length < 8) return m; // "forgot password please" is not a secret
    found.add("secret_code");
    return `${k}${sep}[secret]`;
  });
  s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]");
  s = s.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, () => (found.add("pan"), "[pan]"));
  s = s.replace(/\b(?:\d[ -]?){15,18}\d\b/g, () => (found.add("card_number"), "[card]"));
  s = s.replace(/\b\d{4}\s?\d{4}\s?\d{4}\b(?!\s?\d)/g, () => (found.add("aadhaar"), "[aadhaar]"));
  s = s.replace(/(?:\+91[\s-]?)?\b[6-9]\d{9}\b/g, "[phone]");
  s = s.replace(/\b\d{9,18}\b/g, () => (found.add("bank_account"), "[account-number]"));
  s = s.replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, "[ifsc]");
  return { masked: s, truncated, empty: trimmed.length === 0, sensitive: [...found] };
}

/** Cheap first-pass prompt-injection / abuse patterns. Claude runs a second check. */
const INJECTION = [
  /ignore (all |any )?(the )?(previous|prior|above) (instructions|rules|prompts?)/i,
  /disregard (your|the) (instructions|rules|system prompt)/i,
  /\b(system prompt|developer message|jailbreak)\b/i,
  /you are now (a|an|in) /i,
  /reveal (your|the) (prompt|instructions|rules)/i,
  /<\/?(system|assistant|instructions?)>/i,
  /act as (the )?(admin|administrator|support lead|risk ops)/i,
  /(approve|release|waive) .{0,40}(without|bypass|skip) .{0,20}(check|verification|approval)/i,
];

export function regexThreats(text: string): string[] {
  return INJECTION.filter((r) => r.test(text)).map((r) => r.source);
}
