"use client";

/**
 * @fileoverview Client-side clinical route privacy sandbox.
 *
 * Responsibilities:
 * 1. Invokes vendor cookie-disable hooks and removes third-party analytics globals from `window`.
 * 2. Purges cross-storage tracking identifiers (`RB.uid`, `RB.sessionId`, `_rdt_cfg`, `__pdst`) from
 *    `localStorage` and `sessionStorage` first to prevent multi-storage cookie resurrection.
 * 3. Removes dynamically injected JSONP attribution script nodes from the DOM.
 * 4. Expires external advertising and attribution cookies in `document.cookie`.
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
  "rdt",
  "redditNormalizeEmail",
  "RB",
  "pintrk",
  "hj",
  "_sva",
  "pdst",
  "spdt",
  "rudderanalytics",
] as const;

const FORBIDDEN_STORAGE_KEYS = [
  "RB.uid",
  "RB.sessionId",
  "rb_branch_identify",
  "rb_pinterest_identify",
  "rb_podsights_identify",
  "rb_dialogtech_identify",
  "rb_chartable_identify",
  "_rdt_cfg",
  "__pdst",
  "__spdt",
  "_ju_dc",
] as const;

const FORBIDDEN_JSONP_SCRIPT_IDS = [
  "_rockerbox_jsonP_script",
  "_rockerbox_cname_jsonP_script",
  "_rockerbox_jsonP_integrations",
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
  "rbuid",
  "_rbuid",
  "_rdt_uuid",
  "_rdt_cid",
  "_rdt_em",
  "_rdt_pn",
] as const;

export function ClinicalPrivacySandbox() {
  useEffect(() => {
    const win = window as unknown as Record<string, unknown>;

    // 1. Trigger built-in pixel cookie teardown if present before deleting global reference
    if (typeof win.rdt === "function") {
      try {
        (win.rdt as (cmd: string) => void)("disableFirstPartyCookies");
      } catch {
        // Ignore teardown errors
      }
    }

    // 2. Remove injected JSONP attribution scripts from the DOM
    for (const scriptId of FORBIDDEN_JSONP_SCRIPT_IDS) {
      const el = document.getElementById(scriptId);
      if (el && el.parentNode) {
        el.parentNode.removeChild(el);
      }
    }

    // 3. Purge localStorage and sessionStorage BEFORE expiring cookies to prevent cookie resurrection
    for (const storageKey of FORBIDDEN_STORAGE_KEYS) {
      try {
        window.localStorage?.removeItem(storageKey);
      } catch {
        // Ignore storage access errors
      }
      try {
        window.sessionStorage?.removeItem(storageKey);
      } catch {
        // Ignore storage access errors
      }
    }

    // 4. Remove third-party tracker globals from the window object
    for (const globalKey of FORBIDDEN_WINDOW_GLOBALS) {
      if (globalKey in win) {
        try {
          delete win[globalKey];
        } catch {
          win[globalKey] = undefined;
        }
      }
    }

    // 5. Expire third-party advertising cookies accessible in the document context
    for (const cookieName of FORBIDDEN_TRACKING_COOKIES) {
      document.cookie = `${cookieName}=; Path=/; Max-Age=0; SameSite=Strict`;
    }
  }, []);

  return null;
}
