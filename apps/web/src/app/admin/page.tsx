/**
 * @fileoverview Dedicated Internal Staff Admin Route (`http://localhost:3000/admin`).
 *
 * Enforces Route-Level & Role-Level Separation of Duties:
 * - Consumer Members use `http://localhost:3000/` (`mode="MEMBER"`).
 * - Internal Staff (`CLINICIAN` and `CARE_COORDINATOR`) use `http://localhost:3000/admin` (`mode="ADMIN"`),
 *   where Clinical Prescribing controls and Recurly Billing controls are strictly separated by RBAC.
 */

import TitrateHealthPortal from "../page";

export default function AdminPortalRoute() {
  return <TitrateHealthPortal mode="ADMIN" />;
}