/**
 * @fileoverview Dedicated Internal Admin & Clinician Route (`http://localhost:3000/admin`).
 *
 * Architectural Note for Interviews:
 * Demonstrates Next.js App Router file-system routing (`/admin`). In production,
 * this route (or a dedicated `apps/admin` subdomain behind corporate Okta SSO / VPN)
 * isolates internal `CLINICIAN` and `CARE_COORDINATOR` workflows from the Member portal.
 */

import TitrateHealthPortal from "../page";

export default function AdminPortalRoute() {
  return <TitrateHealthPortal />;
}