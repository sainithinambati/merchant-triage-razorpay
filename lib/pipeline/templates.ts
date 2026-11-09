// Fixed replies used when Claude must not write the text (KB-15, ask-for-info,
// output-check failures). Kept deliberately short and commitment-free.
import type { Decision, FactSheet } from "../types";

const hinglish = (lang: string) => lang === "hinglish";

export function templateReply(decision: Decision, sheet: FactSheet): string {
  const body = baseTemplate(decision, sheet);
  return sheet.facts.security_reminder ? `${body} ${sheet.facts.security_reminder}` : body;
}

function baseTemplate(decision: Decision, sheet: FactSheet): string {
  const hi = hinglish(sheet.language);
  const name = sheet.facts.business_name ? ` ${sheet.facts.business_name} team` : "";

  if (decision.action === "ask_info") {
    const items = decision.ask_for.join(" and ");
    return hi
      ? `Namaste${name}, aapke message ke liye dhanyavaad. Aapki madad karne ke liye kripya apna ${items} share kijiye. Yeh milte hi hum aage check karenge.`
      : `Hello${name}, thank you for reaching out. To help you, please share your ${items}. We will look into this as soon as we have it.`;
  }

  if (decision.action === "escalate" || decision.action === "human") {
    return hi
      ? `Namaste${name}, aapka message mil gaya hai aur hamari concerned team ko bhej diya gaya hai. Woh aapse jald hi sampark karenge.`
      : `Hello${name}, we have received your message and shared it with the team responsible. They will get back to you.`;
  }

  // Fallback after a failed output check: neutral holding reply for an agent to edit.
  return hi
    ? `Namaste${name}, aapke message ke liye dhanyavaad. Hamari team aapki request check kar rahi hai aur jald hi update degi.`
    : `Hello${name}, thank you for your message. Our team is reviewing your request and will update you.`;
}
