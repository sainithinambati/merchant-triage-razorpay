import "server-only";
import { timingSafeEqual } from "node:crypto";

export function safeEqual(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Parse DASHBOARD_USERS="name:password,name2:password2" */
export function dashboardUsers(): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (process.env.DASHBOARD_USERS || "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return map;
}
