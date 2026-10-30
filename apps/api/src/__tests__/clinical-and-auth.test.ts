/**
 * @fileoverview Automated Unit & Security Verification Suite for `@titrate-health`.
 *
 * Covers 3 Critical Engineering Pillars:
 * 1. Shared Domain & Zod Runtime Boundary Validation (`@titrate-health/shared`)
 * 2. GLP-1 Titration Escalation State Machine & Patient Safety Holds (`patient.ts`)
 * 3. Stateless JWT Authentication (HTTP 401) & RBAC Authorization Guards (HTTP 403) (`auth.ts`)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { Request, Response } from "express";
import {
  calculateBmi,
  ClinicalIntakeSubmissionSchema,
  SEMAGLUTIDE_TITRATION_LADDER_MG,
} from "@titrate-health/shared";
import { evaluateTitrationRecommendation } from "../routes/patient.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  hashPassword,
  verifyPassword,
  securityHeaders,
  createRateLimiter,
} from "../middleware/security.js";
import {
  evaluateRecurlyEntitlementSync,
  scrubPhiForServerTelemetry,
} from "../routes/ops.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-fallback-secret";

/**
 * Helper to create a lightweight mock Express Response object for testing middleware
 * without spinning up a live TCP socket.
 */
function createMockResponse() {
  const headers: Record<string, string> = { "X-Powered-By": "Express" };
  const res: Partial<Response> & {
    statusCode?: number;
    body?: unknown;
    headers: Record<string, string>;
  } = { headers };

  res.status = (code: number) => {
    res.statusCode = code;
    return res as Response;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res as Response;
  };
  res.setHeader = (name: string, value: number | string | readonly string[]) => {
    headers[name] = String(value);
    return res as Response;
  };
  res.removeHeader = (name: string) => {
    delete headers[name];
  };
  return res;
}

describe("1. Shared Clinical Domain & Zod Validation (@titrate-health/shared)", () => {
  it("calculates Imperial BMI accurately to 1 decimal place", () => {
    // 215 lbs at 68 inches -> (215 / 4624) * 703 = 32.687... -> 32.7
    assert.equal(calculateBmi(215, 68), 32.7);
    // 165 lbs at 68 inches -> 25.1
    assert.equal(calculateBmi(165, 68), 25.1);
  });

  it("accepts a valid clinical intake payload within physiological bounds", () => {
    const result = ClinicalIntakeSubmissionSchema.safeParse({
      heightInches: 68,
      weightLb: 215,
      goalWeightLb: 165,
      comorbidities: ["HYPERTENSION"],
      contraindications: [],
    });
    assert.equal(result.success, true);
  });

  it("rejects out-of-bounds physiological values and unknown medical enums", () => {
    const invalidResult = ClinicalIntakeSubmissionSchema.safeParse({
      heightInches: 12, // Below 48-inch minimum
      weightLb: 1500, // Above 800-lb maximum
      comorbidities: ["NOT_A_REAL_CONDITION"],
    });
    assert.equal(invalidResult.success, false);
  });
});

describe("2. GLP-1 Titration Escalation State Machine (Clinical Safety Rules)", () => {
  it("returns AWAITING_INITIATION when patient has no prior medication logs", () => {
    const rec = evaluateTitrationRecommendation(undefined);
    assert.equal(rec.recommendationStatus, "AWAITING_INITIATION");
    assert.equal(rec.nextRecommendedDosageMg, SEMAGLUTIDE_TITRATION_LADDER_MG[0]);
  });

  it("recommends CONTINUE_CURRENT_STEP during Weeks 1-3 with no side effects", () => {
    const rec = evaluateTitrationRecommendation({
      dosageMg: 0.25,
      weekNumber: 2,
      sideEffects: ["NONE"],
    });
    assert.equal(rec.recommendationStatus, "CONTINUE_CURRENT_STEP");
    assert.equal(rec.nextRecommendedDosageMg, 0.25);
  });

  it("transitions to ELIGIBLE_FOR_STEP_UP (0.25mg -> 0.5mg) on Week 4 when well tolerated", () => {
    const rec = evaluateTitrationRecommendation({
      dosageMg: 0.25,
      weekNumber: 4,
      sideEffects: ["NONE"],
    });
    assert.equal(rec.recommendationStatus, "ELIGIBLE_FOR_STEP_UP");
    assert.equal(rec.nextRecommendedDosageMg, 0.5);
  });

  it("enforces HOLD_DOSE_SIDE_EFFECT_MANAGEMENT even on Week 4 if GI side effects are reported", () => {
    const rec = evaluateTitrationRecommendation({
      dosageMg: 0.5,
      weekNumber: 8,
      sideEffects: ["MILD_NAUSEA"],
    });
    assert.equal(rec.recommendationStatus, "HOLD_DOSE_SIDE_EFFECT_MANAGEMENT");
    // Must NOT escalate to 1.0mg when nausea is present!
    assert.equal(rec.nextRecommendedDosageMg, 0.5);
  });

  it("caps dosage at 2.4mg (MAINTENANCE_DOSE_REACHED) at the top of the FDA ladder", () => {
    const rec = evaluateTitrationRecommendation({
      dosageMg: 2.4,
      weekNumber: 20,
      sideEffects: ["NONE"],
    });
    assert.equal(rec.recommendationStatus, "MAINTENANCE_DOSE_REACHED");
    assert.equal(rec.nextRecommendedDosageMg, 2.4);
  });
});

describe("3. Stateless JWT Authentication (401) & RBAC Middleware (403)", () => {
  it("returns 401 Unauthorized when Authorization Bearer header is missing or forged", () => {
    const reqMissing = { headers: {} } as Request;
    const resMissing = createMockResponse();
    let nextCalled = false;

    requireAuth(reqMissing, resMissing as Response, () => {
      nextCalled = true;
    });

    assert.equal(resMissing.statusCode, 401);
    assert.equal(nextCalled, false);

    // Forged / invalid signature token
    const reqForged = {
      headers: { authorization: "Bearer tampered.jwt.token" },
    } as Request;
    const resForged = createMockResponse();
    requireAuth(reqForged, resForged as Response, () => {
      nextCalled = true;
    });
    assert.equal(resForged.statusCode, 401);
  });

  it("enforces RBAC: blocks PATIENT with 403 Forbidden on CLINICIAN route, permits CLINICIAN", () => {
    const patientToken = jwt.sign(
      { userId: "patient-uuid-1", role: "PATIENT" },
      JWT_SECRET
    );
    const reqPatient = {
      headers: { authorization: `Bearer ${patientToken}` },
    } as Request;
    const resPatient = createMockResponse();

    // 1. Authenticate PATIENT token
    requireAuth(reqPatient, resPatient as Response, () => { });
    assert.equal(reqPatient.user?.role, "PATIENT");

    // 2. Attempt to pass requireRole(["CLINICIAN"]) -> Expect 403 Forbidden
    let clinicianRouteReached = false;
    const clinicianGuard = requireRole(["CLINICIAN"]);
    clinicianGuard(reqPatient, resPatient as Response, () => {
      clinicianRouteReached = true;
    });

    assert.equal(resPatient.statusCode, 403);
    assert.equal(clinicianRouteReached, false);

    // 3. Verify CLINICIAN token passes the exact same guard
    const reqClinician = {
      user: { userId: "clinician-uuid-1", role: "CLINICIAN" },
    } as unknown as Request;
    const resClinician = createMockResponse();
    clinicianGuard(reqClinician, resClinician as Response, () => {
      clinicianRouteReached = true;
    });

    assert.equal(clinicianRouteReached, true);
  });
});
describe("4. Cryptographic Password Hashing (scrypt), Security Headers & Rate Limiting (429)", () => {
  it("generates unique salted scrypt hashes and verifies passwords in constant time", () => {
    const hash1 = hashPassword("ClinicalSecret2026!");
    const hash2 = hashPassword("ClinicalSecret2026!");

    // Two hashes of the exact same password MUST differ due to unique 16-byte salts
    assert.notEqual(hash1, hash2);

    assert.equal(verifyPassword("ClinicalSecret2026!", hash1), true);
    assert.equal(verifyPassword("WrongPassword123!", hash1), false);
  });

  it("attaches OWASP HTTP security headers and strips X-Powered-By", () => {
    const req = {} as Request;
    const res = createMockResponse();
    let nextCalled = false;

    securityHeaders(req, res as unknown as Response, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(res.headers["X-Powered-By"], undefined);
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(res.headers["X-Frame-Options"], "DENY");
  });

  it("enforces IP rate limiting and returns HTTP 429 Too Many Requests when exceeded", () => {
    const limiter = createRateLimiter(2, 60_000); // Allow max 2 requests per window
    const req = { ip: "192.168.1.50" } as Request;

    const res1 = createMockResponse();
    let passed = 0;
    limiter(req, res1 as unknown as Response, () => {
      passed += 1;
    });

    const res2 = createMockResponse();
    limiter(req, res2 as unknown as Response, () => {
      passed += 1;
    });

    // 3rd request from the same IP should be blocked with 429 Too Many Requests
    const res3 = createMockResponse();
    limiter(req, res3 as unknown as Response, () => {
      passed += 1;
    });

    assert.equal(passed, 2);
    assert.equal(res3.statusCode, 429);
    assert.equal(res3.headers["X-RateLimit-Remaining"], "0");
  });
});

describe("5. Recurly Subscription Entitlement Sync, Dunning Grace & HIPAA PHI Scrubbing", () => {
  it("enforces webhook idempotency so duplicate Recurly webhook IDs are skipped", () => {
    const seenIds = new Set<string>();
    const firstAttempt = evaluateRecurlyEntitlementSync({
      webhookId: "recurly_wh_9001",
      eventType: "invoice.paid",
      accountEmail: "alex.rivera@patient.com",
      alreadyProcessedIds: seenIds,
    });
    assert.equal(firstAttempt.idempotentSkip, false);
    assert.equal(firstAttempt.recurlyState, "ACTIVE");

    // Duplicate delivery of the exact same webhook ID must be a safe No-Op
    const duplicateAttempt = evaluateRecurlyEntitlementSync({
      webhookId: "recurly_wh_9001",
      eventType: "invoice.paid",
      accountEmail: "alex.rivera@patient.com",
      alreadyProcessedIds: seenIds,
    });
    assert.equal(duplicateAttempt.idempotentSkip, true);
  });

  it("activates 7-day clinical continuity grace period on Recurly dunning instead of halting GLP-1", () => {
    const seenIds = new Set<string>();
    const dunningResult = evaluateRecurlyEntitlementSync({
      webhookId: "recurly_wh_dunning_01",
      eventType: "dunning.new_dunning_event",
      accountEmail: "alex.rivera@patient.com",
      alreadyProcessedIds: seenIds,
    });
    assert.equal(dunningResult.recurlyState, "DUNNING_GRACE_PERIOD");
  });

  it("automatically voids and refunds Recurly subscription when clinical intake is INELIGIBLE", () => {
    const seenIds = new Set<string>();
    const ineligibleResult = evaluateRecurlyEntitlementSync({
      webhookId: "recurly_wh_ineligible_01",
      eventType: "clinical.intake_ineligible",
      accountEmail: "alex.rivera@patient.com",
      intakeStatus: "INELIGIBLE",
      alreadyProcessedIds: seenIds,
    });
    assert.equal(ineligibleResult.recurlyState, "CANCELED_REFUNDED_INELIGIBLE");
  });

  it("scrubs PHI (weight, BMI, comorbidities) and 3rd-party ad cookies (ttcsid, sc_at) before Braze dispatch", () => {
    const scrubbed = scrubPhiForServerTelemetry({
      campaignName: "week_4_glp1_step_up_reminder",
      userId: "uuid-1234",
      weightLb: 215,
      calculatedBmi: 32.7,
      comorbidities: ["HYPERTENSION"],
      ttcsid: "tiktok_tracking_cookie_123",
      sc_at: "snapchat_cookie_456",
    });

    assert.equal(scrubbed.hipaaCompliant, true);
    assert.equal("weightLb" in scrubbed.safeAttributes, false);
    assert.equal("calculatedBmi" in scrubbed.safeAttributes, false);
    assert.equal("ttcsid" in scrubbed.safeAttributes, false);
    assert.equal(scrubbed.safeAttributes.campaignName, "week_4_glp1_step_up_reminder");
  });
});