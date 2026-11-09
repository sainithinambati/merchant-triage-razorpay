// Date helpers. All dates are handled as YYYY-MM-DD strings in IST business terms.

// National bank holidays only. Festival holidays vary by state and year: load the
// RBI list into this set (or a Supabase table) before relying on business-day maths.
export const BANK_HOLIDAYS = new Set<string>([
  "2026-01-26", // Republic Day
  "2026-08-15", // Independence Day
  "2026-10-02", // Gandhi Jayanti
  "2026-12-25", // Christmas
]);

export function todayISO(override?: string): string {
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) return override;
  // IST date
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function toDate(iso: string) {
  return new Date(iso + "T00:00:00Z");
}

export function isBusinessDay(iso: string): boolean {
  const d = toDate(iso).getUTCDay();
  return d !== 0 && d !== 6 && !BANK_HOLIDAYS.has(iso);
}

export function addBusinessDays(iso: string, n: number): string {
  const d = toDate(iso);
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (isBusinessDay(d.toISOString().slice(0, 10))) added++;
  }
  return d.toISOString().slice(0, 10);
}

/** "2026-10-02" -> "2 Oct 2026". This is the only date format replies may use. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = toDate(iso.slice(0, 10));
  const m = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}`;
}

/** 430000 -> "Rs. 4,30,000" (Indian grouping). Merchant amounts are stored in rupees, as in the Excel. */
export function fmtRupees(rupees: number | null | undefined): string {
  if (rupees == null) return "";
  return "Rs. " + Number(rupees).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
