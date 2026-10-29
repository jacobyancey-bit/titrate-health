/**
 * @fileoverview Shared Domain Contracts, Clinical Constants, and Validation Schemas.
 *
 * Architectural Role:
 * Acts as the Single Source of Truth (SSOT) between the React frontend (`apps/web`)
 * and Express API (`apps/api`). Defining Zod schemas here ensures runtime payload
 * validation on the server matches form validation in the browser.
 */

import { z } from "zod";

/**
 * Standard FDA-aligned Semaglutide step-up titration schedule (in milligrams).
 * Patients typically remain on each step for at least 4 weeks before escalating.
 */
export const SEMAGLUTIDE_TITRATION_LADDER_MG = [0.25, 0.5, 1.0, 1.7, 2.4] as const;

/**
 * Absolute clinical contraindications (exclusion criteria) for GLP-1 therapy.
 * Presence of any condition in this list automatically flags an intake as `INELIGIBLE`.
 */
export const CONTRAINDICATIONS = [
  "MEDULLARY_THYROID_CARCINOMA_HISTORY",
  "MEN2_SYNDROME",
  "PREGNANCY_OR_NURSING",
  "SEVERE_GI_DISEASE",
  "PANCREATITIS_HISTORY",
] as const;

/**
 * Weight-related comorbidities that lower the clinical BMI eligibility threshold
 * for GLP-1 therapy from BMI >= 30.0 down to BMI >= 27.0.
 */
export const COMORBIDITIES = [
  "HYPERTENSION",
  "TYPE_2_DIABETES",
  "PREDIABETES",
  "DYSLIPIDEMIA",
  "OBSTRUCTIVE_SLEEP_APNEA",
] as const;

/**
 * Runtime Zod validation schema for a patient's initial clinical intake submission.
 * Enforces physiological bounds on height/weight and restricts medical arrays to known enums.
 */
export const ClinicalIntakeSubmissionSchema = z.object({
  heightInches: z
    .number()
    .min(48, "Height must be at least 48 inches")
    .max(96, "Height cannot exceed 96 inches"),
  weightLb: z
    .number()
    .min(70, "Weight must be at least 70 lbs")
    .max(800, "Weight cannot exceed 800 lbs"),
  goalWeightLb: z.number().min(70).max(800).optional(),
  comorbidities: z.array(z.enum(COMORBIDITIES)).default([]),
  contraindications: z.array(z.enum(CONTRAINDICATIONS)).default([]),
});

/**
 * Compile-time TypeScript type automatically inferred from `ClinicalIntakeSubmissionSchema`.
 * Eliminates manual synchronization between runtime validation and static types.
 */
export type ClinicalIntakeSubmission = z.infer<typeof ClinicalIntakeSubmissionSchema>;

/**
 * Calculates Body Mass Index (BMI) using the standard Imperial clinical formula:
 * `BMI = (weightLb / heightInches^2) * 703`
 *
 * @param weightLb - Patient weight in pounds.
 * @param heightInches - Patient height in inches.
 * @returns BMI rounded to 1 decimal place (e.g., `28.4`).
 */
export function calculateBmi(weightLb: number, heightInches: number): number {
  const rawBmi = (weightLb / (heightInches * heightInches)) * 703;
  return Number(rawBmi.toFixed(1));
}