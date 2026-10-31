"use client";

/**
 * @fileoverview Client-side clinical route privacy sandbox.
 * Purges third-party analytics globals from the browser window object and
 * expires external advertising cookies when transitioning into clinical routes.
 */

import { useEffect } from "react";

const FORBIDDEN_WINDOW_GLOBALS = [
  "clarity",
  "braze",
  "appboy",
  "dataLayer",
  "google_tag_manager",
  "analytics",
  "fbq",
  "ttq",
] as const;

const FORBIDDEN_TRACKING_COOKIES = [
  "MUID",
  "_fbp",
  "_ttp",
  "_clck",
  "_clsk",
  "ttcsid",
  "sc_at",
  "t_gid",
] as const;

export function ClinicalPrivacySandbox() {
  useEffect(() => {
    const win = window as unknown as Record<string, unknown>;

    // Remove third-party tracker globals from the window object
    for (const globalKey of FORBIDDEN_WINDOW_GLOBALS) {
      if (globalKey in win) {
        try {
          delete win[globalKey];
        } catch {
          win[globalKey] = undefined;
        }
      }
    }

    // Expire third-party advertising cookies accessible in the document context
    for (const cookieName of FORBIDDEN_TRACKING_COOKIES) {
      document.cookie = `${cookieName}=; Path=/; Max-Age=0; SameSite=Strict`;
    }
  }, []);

  return null;
}