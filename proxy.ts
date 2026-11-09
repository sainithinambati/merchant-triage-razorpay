// Dashboard login (HTTP basic auth). Machine endpoints use their own secrets.
import { NextResponse, type NextRequest } from "next/server";

function users(): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of (process.env.DASHBOARD_USERS || "").split(",")) {
    const i = pair.indexOf(":");
    if (i > 0) map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return map;
}

export function proxy(req: NextRequest) {
  const header = req.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const [user, ...rest] = atob(header.slice(6)).split(":");
      const pass = rest.join(":");
      const expected = users().get(user);
      if (expected && expected === pass) {
        const headers = new Headers(req.headers);
        headers.set("x-agent", user);
        return NextResponse.next({ request: { headers } });
      }
    } catch {
      /* fall through */
    }
  }
  return new NextResponse("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Support dashboard"' },
  });
}

export const config = {
  matcher: ["/((?!api/webhook|api/tickets|api/cron|_next/static|_next/image|favicon.ico).*)"],
};
