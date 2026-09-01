import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Next.js 16 renamed the `middleware` file convention to `proxy` (runs on the Node.js runtime,
// which is required here since `auth()` needs a DB lookup via the Prisma session adapter).
export default auth((req) => {
  if (req.auth) return;

  const isApiRoute = req.nextUrl.pathname.startsWith("/api");
  if (isApiRoute) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
  return NextResponse.redirect(signInUrl);
});

export const config = {
  // Everything except: the auth routes themselves, the GitHub webhook receiver (HMAC-signed,
  // called by GitHub not a signed-in user) and the external trigger endpoint (Bearer-token
  // authenticated), plus static assets. Note `/api/webhooks/github/...` is excluded but
  // `/api/webhooks` (the CRUD routes for managing webhook configs) is NOT — those need login.
  matcher: [
    "/((?!api/auth|api/webhooks/github|api/external|api/terminal/callback|_next/static|_next/image|favicon.ico|icon.svg).*)",
  ],
};
