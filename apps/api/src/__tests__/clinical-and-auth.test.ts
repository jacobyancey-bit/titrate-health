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

const JWT_SECRET = process.env.JWT_SECRET || "dev-fallback-secret";

/**
 * Helper to create a lightweight mock Express Response object for testing middleware
 * without spinning up a live TCP socket.
 */
function createMockResponse() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res as Response;
  };
  res.json = (payload: unknown) => {
    res.body = payload;
    return res as Response;
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
    requireAuth(reqPatient, resPatient as Response, () => {});
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