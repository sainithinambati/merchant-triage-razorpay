// Output check: pure code that verifies a reply only says what the fact sheet allows.
// Runs on Claude's draft AND on any agent edit before sending.
import type { FactSheet, OutputCheckResult } from "../types";

const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/gi)) {
    out.push(`${Number(m[1])}-${m[2].toLowerCase()}`);
  }
  for (const m of text.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi)) {
    out.push(`${Number(m[2])}-${m[1].toLowerCase()}`);
  }
  for (const m of text.matchAll(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/g)) {
    const mon = MONTHS[Number(m[2]) - 1];
    if (mon) out.push(`${Number(m[1])}-${mon}`);
  }
  return out;
}

function amountsIn(text: string): number[] {
  return [...text.matchAll(/(?:rs\.?|inr|₹)\s?([\d,]+(?:\.\d{1,2})?)/gi)].map((m) => Number(m[1].replace(/,/g, "")));
}

function durationsIn(text: string): string[] {
  return [...text.matchAll(/\b(\d+)\s*(?:-|to)?\s*(\d+)?\s*(?:additional |more |extra )?(business days?|calendar days?|working days?|days?|hours?|months?)\b/gi)]
    .map((m) => `${m[1]}${m[2] ? "-" + m[2] : ""} ${m[3].toLowerCase().replace(/s$/, "").replace("working", "business")}`);
}

const GLOBAL_BLOCKS: [RegExp, string][] = [
  [/\b(guarantee[ds]?|i promise|we promise|100% (sure|certain)|rest assured)\b/i, "makes a promise"],
  [/\bwill (definitely|surely|certainly)\b/i, "makes a promise"],
  [/\b(our (mistake|fault|error)|we (made|have made) (a|an) (mistake|error)|we are (at fault|responsible for))\b/i, "admits fault"],
  [/\bhttps?:\/\/|www\./i, "contains a link (only Dashboard paths are allowed)"],
  [/\b(ignore|as an ai|language model|system prompt)\b/i, "leaks model or prompt text"],
];

export function checkOutput(reply: string, sheet: FactSheet, forbiddenTerms: string[] = []): OutputCheckResult {
  const blocking: string[] = [];
  const warnings: string[] = [];
  const text = reply.trim();
  if (!text) return { passed: false, blocking: ["Reply is empty"], warnings };

  const factText = Object.values(sheet.facts).join(" | ");
  const allowedText = factText + " | " + sheet.guidance.map((g) => g.text).join(" | ");

  // 1. Dates must come from the facts.
  const allowedDates = new Set(datesIn(factText));
  for (const d of datesIn(text)) if (!allowedDates.has(d)) blocking.push(`Date not in system data: ${d}`);

  // 2. Rupee amounts must come from facts or KB guidance.
  const allowedAmounts = new Set(amountsIn(allowedText));
  for (const a of amountsIn(text)) if (!allowedAmounts.has(a)) blocking.push(`Amount not in system data: Rs. ${a}`);

  // 3. Durations ("5-7 business days", "24 hours") must appear in the KB guidance.
  const allowedDurations = new Set(durationsIn(allowedText));
  for (const d of durationsIn(text)) if (!allowedDurations.has(d)) blocking.push(`Timeline not in KB: ${d}`);

  // 4. Promise / fault / link patterns.
  for (const [re, why] of GLOBAL_BLOCKS) if (re.test(text)) blocking.push(`Reply ${why}`);

  // 5. Rule-specific forbidden terms (skipped if the term is itself a fact).
  for (const term of forbiddenTerms) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text) && !re.test(factText)) blocking.push(`Forbidden for this case: "${term}"`);
  }

  // 6. PII and other merchants' IDs.
  for (const m of text.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    if (!allowedText.includes(m[0])) blocking.push(`Contains an email address: ${m[0]}`);
  }
  if (/(?:\+91[\s-]?)?\b[6-9]\d{9}\b/.test(text)) blocking.push("Contains a phone number");
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)) blocking.push("Contains a PAN");
  if (/\b\d{9,18}\b/.test(text)) blocking.push("Contains a long number (possible account number)");
  for (const m of text.matchAll(/\bM\d{4}\b/g)) {
    if (m[0] !== sheet.facts.merchant_id) blocking.push(`Mentions another merchant ID: ${m[0]}`);
  }

  // 7. Soft checks.
  if (text.length > 1200) warnings.push("Reply is long (over 1200 characters)");
  if (sheet.language === "hinglish" && !/\b(aap|aapka|hai|hain|kar|kijiye|karein|ho|ki|ka|ke)\b/i.test(text)) {
    warnings.push("Merchant wrote in Hinglish but the reply looks like plain English");
  }

  return { passed: blocking.length === 0, blocking: [...new Set(blocking)], warnings };
}
