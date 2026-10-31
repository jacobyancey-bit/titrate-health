/**
 * @fileoverview Next.js Edge Middleware for URL sanitization and attribution tokenization.
 *
 * Responsibilities:
 * 1. Intercepts incoming query parameters containing advertising click identifiers or search terms.
 * 2. Stores non-clinical attribution tokens in a short-lived HttpOnly, SameSite=Strict cookie.
 * 3. Redirects the browser to a clean URL path so ad identifiers and medical terms
 *    do not persist in the address bar, browser history, or Referer headers.
 */

import { NextRequest, NextResponse } from "next/server";

const SENSITIVE_OR_AD_QUERY_PARAMS = [
  "gbraid",
  "wbraid",
  "gclid",
  "g_adid",
  "g_adgroupid",
  "cid",
  "controllingTerms",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "ttclid",
] as const;

export function middleware(request: NextRequest) {
  const url = request.nextUrl.clone();
  let hasSensitiveParams = false;
  const capturedAttribution: Record<string, string> = {};

  for (const param of SENSITIVE_OR_AD_QUERY_PARAMS) {
    const val = url.searchParams.get(param);
    if (val !== null) {
      hasSensitiveParams = true;
      // Only retain opaque campaign attribution IDs; drop search terms (`controllingTerms`, `utm_term`)
      if (param !== "controllingTerms" && param !== "utm_term") {
        capturedAttribution[param] = val;
      }
      url.searchParams.delete(param);
    }
  }

  if (hasSensitiveParams) {
    const response = NextResponse.redirect(url, 307);

    // Store tokenized attribution in a short-lived (15-minute) HttpOnly cookie
    if (Object.keys(capturedAttribution).length > 0) {
      const tokenPayload = Buffer.from(JSON.stringify(capturedAttribution)).toString(
        "base64url"
      );
      response.cookies.set("titrate_attr_session", tokenPayload, {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 900,
      });
    }

    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|site.webmanifest).*)"],
};