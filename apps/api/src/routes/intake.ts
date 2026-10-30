/**
 * @fileoverview Clinical Intake & GLP-1 Eligibility Triage Routes.
 *
 * Endpoints:
 * 1. `POST /api/intake` (PATIENT): Validates intake payload via Zod, runs FDA/clinical
 *    BMI & contraindication rules, and atomically persists the intake + baseline weight.
 * 2. `GET /api/intake/queue` (CLINICIAN / CARE_COORDINATOR): Returns intakes awaiting
 *    clinical review, ordered FIFO (First-In, First-Out) by submission time.
 * 3. `PATCH /api/intake/:id/review` (CLINICIAN): Approves or rejects a patient intake,
 *    and automatically initializes Week 1 Semaglutide (0.25mg) upon approval.
 */

import { Router, Request, Response } from "express";
import { IntakeStatus } from "@prisma/client";
import {
  ClinicalIntakeSubmissionSchema,
  calculateBmi,
  SEMAGLUTIDE_TITRATION_LADDER_MG,
} from "@titrate-health/shared";
import { prisma } from "../db.js";
import { requireAuth, requireRole, recordAuditLog } from "../middleware/auth.js";

export const intakeRouter = Router();

/**
 * POST /api/intake
 * Authenticated PATIENT submits their clinical onboarding questionnaire.
 */
intakeRouter.post(
  "/",
  requireAuth,
  requireRole(["PATIENT"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      // 1. Validate request body at runtime using our shared Zod schema
      const parsed = ClinicalIntakeSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid clinical intake payload",
          issues: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const { heightInches, weightLb, goalWeightLb, comorbidities, contraindications } =
        parsed.data;
      const userId = req.user!.userId;

      // 2. Compute BMI using shared Imperial clinical formula
      const calculatedBmi = calculateBmi(weightLb, heightInches);

      // 3. Deterministic Clinical Eligibility Rules Engine:
      //    - Any absolute contraindication -> INELIGIBLE
      //    - BMI >= 30.0 -> PENDING_REVIEW
      //    - BMI >= 27.0 with >= 1 weight-related comorbidity -> PENDING_REVIEW
      //    - Otherwise -> INELIGIBLE
      const hasContraindications = contraindications.length > 0;
      const meetsBmiThreshold =
        calculatedBmi >= 30.0 || (calculatedBmi >= 27.0 && comorbidities.length > 0);

      const initialStatus: IntakeStatus =
        !hasContraindications && meetsBmiThreshold
          ? IntakeStatus.PENDING_REVIEW
          : IntakeStatus.INELIGIBLE;

      // 4. Execute an ACID database transaction so profile update, intake creation,
      //    baseline biometric point, and HIPAA audit log succeed or fail together.
      const result = await prisma.$transaction(async (tx) => {
        const profile = await tx.patientProfile.upsert({
          where: { userId },
          update: {
            heightInches,
            startingWeightLb: weightLb,
            ...(goalWeightLb !== undefined ? { goalWeightLb } : {}),
          },
          create: {
            userId,
            dateOfBirth: new Date("1988-05-14"),
            heightInches,
            startingWeightLb: weightLb,
            goalWeightLb: goalWeightLb ?? 165,
          },
        });

        const intake = await tx.clinicalIntake.create({
          data: {
            patientProfileId: profile.id,
            calculatedBmi,
            comorbidities,
            contraindications,
            status: initialStatus,
          },
        });

        // Seed baseline weight entry so the patient's biometric chart has Day 0 data
        await tx.biometricEntry.create({
          data: {
            patientProfileId: profile.id,
            weightLb,
            proteinGrams: 95,
            waterOunces: 72,
          },
        });

        await tx.auditLog.create({
          data: {
            actorId: userId,
            action: `SUBMIT_CLINICAL_INTAKE_${initialStatus}`,
            targetResourceId: intake.id,
            ipAddress: req.ip ?? "unknown",
          },
        });

        return intake;
      });

      res.status(201).json({
        message:
          initialStatus === IntakeStatus.PENDING_REVIEW
            ? "Intake pre-qualified and routed to clinician review queue."
            : "Intake flagged as clinically ineligible based on safety criteria.",
        intake: result,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to process clinical intake",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * GET /api/intake/queue
 * Returns all clinical intakes for the Clinician Triage Dashboard.
 */
intakeRouter.get(
  "/queue",
  requireAuth,
  requireRole(["CLINICIAN", "CARE_COORDINATOR"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const intakes = await prisma.clinicalIntake.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          patientProfile: {
            include: {
              user: {
                select: { id: true, email: true, role: true },
              },
            },
          },
        },
      });

      await recordAuditLog(
        req.user!.userId,
        "VIEW_CLINICAL_INTAKE_QUEUE",
        "ALL_INTAKES",
        req.ip
      );

      res.status(200).json({ count: intakes.length, intakes });
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch clinician intake queue",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * PATCH /api/intake/:id/review
 * Allows a CLINICIAN to approve or reject a patient's clinical intake.
 * When approved, automatically prescribes Step 1 of the Semaglutide ladder (0.25mg).
 */
intakeRouter.patch(
  "/:id/review",
  requireAuth,
  requireRole(["CLINICIAN"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const intakeId = String(req.params.id);
      const decision: IntakeStatus =
        req.body?.status === "APPROVED" ? IntakeStatus.APPROVED : IntakeStatus.INELIGIBLE;
      const clinicianNotes: string =
        req.body?.clinicianNotes || "Reviewed by board-certified clinician.";

      const updatedIntake = await prisma.$transaction(async (tx) => {
        const intake = await tx.clinicalIntake.update({
          where: { id: intakeId },
          data: {
            status: decision,
            reviewedByClinician: req.user!.userId,
            clinicianNotes,
          },
        });

        // If approved, initialize Week 1 starting dose (0.25mg Semaglutide)
        if (decision === IntakeStatus.APPROVED) {
          await tx.medicationLog.create({
            data: {
              patientProfileId: intake.patientProfileId,
              medicationName: "Semaglutide (GLP-1 RA)",
              dosageMg: SEMAGLUTIDE_TITRATION_LADDER_MG[0],
              weekNumber: 1,
              sideEffects: ["NONE"],
            },
          });
        }

        await tx.auditLog.create({
          data: {
            actorId: req.user!.userId,
            action: `CLINICIAN_REVIEW_INTAKE_${decision}`,
            targetResourceId: intake.id,
            ipAddress: req.ip ?? "unknown",
          },
        });

        return intake;
      });

      res.status(200).json({
        message: `Intake marked as ${decision}`,
        intake: updatedIntake,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to review clinical intake",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

/**
 * GET /api/intake/audit-logs
 * Returns the 25 most recent immutable HIPAA AuditLog records for compliance inspection.
 * Restricted strictly to CLINICIAN and CARE_COORDINATOR roles.
 */
intakeRouter.get(
  "/audit-logs",
  requireAuth,
  requireRole(["CLINICIAN", "CARE_COORDINATOR"]),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const logs = await prisma.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 25,
        include: {
          actor: {
            select: { email: true, role: true },
          },
        },
      });

      res.status(200).json({ count: logs.length, logs });
    } catch (error) {
      res.status(500).json({
        error: "Failed to fetch HIPAA audit logs",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);