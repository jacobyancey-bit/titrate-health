/**
 * @fileoverview Patient Dashboard, GLP-1 Titration State Machine, Biometric Logging,
 * and Redis Cache-Aside Implementation.
 *
 * Endpoints:
 * 1. `GET /api/patient/dashboard`: Aggregates patient profile, intake status, weight
 *    trajectory, medication logs, and next GLP-1 titration recommendation (cached in Redis).
 * 2. `POST /api/patient/biometrics`: Logs a new weight/protein/water check-in and
 *    invalidates the Redis dashboard cache.
 * 3. `POST /api/patient/medication-log`: Logs a weekly Semaglutide injection, evaluates
 *    titration step progression, and invalidates the Redis dashboard cache.
 */

import { Router, Request, Response } from "express";
import { Redis } from "ioredis";
import { z } from "zod";
import {
  SEMAGLUTIDE_TITRATION_LADDER_MG,
  calculateBmi,
} from "@titrate-health/shared";
import { prisma } from "../db.js";
import { requireAuth, requireRole, recordAuditLog } from "../middleware/auth.js";

export const patientRouter = Router();

/**
 * Redis client singleton connected to the local Docker Redis 7 instance (`localhost:6379`).
 * Configured with `lazyConnect` and silent error handling so the API gracefully degrades
 * to PostgreSQL if Redis is ever temporarily unavailable.
 */
const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 1,
  lazyConnect: true,
});
redis.on("error", () => {
  // Suppress unhandled error events; route handlers gracefully fall back to PostgreSQL.
});

const DASHBOARD_CACHE_TTL_SECONDS = 60;
const getDashboardCacheKey = (userId: string): string => `patient:dashboard:${userId}`;

/**
 * Pure clinical state machine function that computes the patient's current and
 * recommended next Semaglutide dosage along `[0.25, 0.5, 1.0, 1.7, 2.4]` mg.
 */
function evaluateTitrationRecommendation(
  latestLog?: { dosageMg: number; weekNumber: number; sideEffects: string[] }
) {
  if (!latestLog) {
    return {
      currentDosageMg: 0,
      nextRecommendedDosageMg: SEMAGLUTIDE_TITRATION_LADDER_MG[0],
      currentWeek: 0,
      recommendationStatus: "AWAITING_INITIATION",
      clinicalRationale: "Complete clinical intake approval to begin Week 1 (0.25mg).",
    };
  }

  const currentIdx = SEMAGLUTIDE_TITRATION_LADDER_MG.findIndex(
    (step) => step === latestLog.dosageMg
  );
  const safeIdx = currentIdx === -1 ? 0 : currentIdx;
  const hasGiSideEffects = latestLog.sideEffects.some(
    (s) => s !== "NONE" && s.trim().length > 0
  );

  // Rule 1: Hold current dose if patient reported GI side effects
  if (hasGiSideEffects) {
    return {
      currentDosageMg: latestLog.dosageMg,
      nextRecommendedDosageMg: latestLog.dosageMg,
      currentWeek: latestLog.weekNumber,
      recommendationStatus: "HOLD_DOSE_SIDE_EFFECT_MANAGEMENT",
      clinicalRationale: `Reported side effects (${latestLog.sideEffects.join(", ")}). Hold at ${latestLog.dosageMg}mg to allow GI adaptation.`,
    };
  }

  // Rule 2: Already at maximum maintenance dose (2.4mg)
  if (safeIdx >= SEMAGLUTIDE_TITRATION_LADDER_MG.length - 1) {
    return {
      currentDosageMg: latestLog.dosageMg,
      nextRecommendedDosageMg: latestLog.dosageMg,
      currentWeek: latestLog.weekNumber,
      recommendationStatus: "MAINTENANCE_DOSE_REACHED",
      clinicalRationale: "Patient is at maximum FDA-approved maintenance dosage (2.4mg).",
    };
  }

  // Rule 3: Eligible to escalate every 4 weeks; otherwise continue current step
  const readyToEscalate = latestLog.weekNumber % 4 === 0;
  const nextDose = readyToEscalate
    ? SEMAGLUTIDE_TITRATION_LADDER_MG[safeIdx + 1]
    : latestLog.dosageMg;

  return {
    currentDosageMg: latestLog.dosageMg,
    nextRecommendedDosageMg: nextDose,
    currentWeek: latestLog.weekNumber,
    recommendationStatus: readyToEscalate
      ? "ELIGIBLE_FOR_STEP_UP"
      : "CONTINUE_CURRENT_STEP",
    clinicalRationale: readyToEscalate
      ? `Completed 4-week block at ${latestLog.dosageMg}mg with no side effects. Eligible to titrate up to ${nextDose}mg.`
      : `Week ${latestLog.weekNumber} complete. Continue ${latestLog.dosageMg}mg until 4-week step-up threshold.`,
  };
}

/**
 * GET /api/patient/dashboard
 * Returns the full clinical telemetry payload for the authenticated patient.
 * Uses the Redis Cache-Aside pattern (`REDIS_HIT` vs `POSTGRES_MISS`).
 */
patientRouter.get(
  "/dashboard",
  requireAuth,
  requireRole(["PATIENT", "CLINICIAN"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const userId = req.user!.userId;
      const cacheKey = getDashboardCacheKey(userId);

      // 1. Check Redis Cache first (Fast Path)
      try {
        const cachedPayload = await redis.get(cacheKey);
        if (cachedPayload) {
          res.status(200).json({
            cacheSource: "REDIS_HIT",
            data: JSON.parse(cachedPayload),
          });
          return;
        }
      } catch {
        // Proceed to PostgreSQL if Redis is unreachable
      }

      // 2. Cache Miss: Query PostgreSQL relational tables via Prisma
      const profile = await prisma.patientProfile.findUnique({
        where: { userId },
        include: {
          intakes: { orderBy: { createdAt: "desc" }, take: 1 },
          medicationLogs: { orderBy: { administeredAt: "desc" }, take: 12 },
          biometrics: { orderBy: { recordedAt: "asc" }, take: 30 },
        },
      });

      if (!profile) {
        res.status(404).json({ error: "Patient profile not found" });
        return;
      }

      const latestBiometric = profile.biometrics[profile.biometrics.length - 1];
      const currentWeightLb = latestBiometric?.weightLb ?? profile.startingWeightLb;
      const currentBmi = calculateBmi(currentWeightLb, profile.heightInches);
      const totalWeightChangeLb = Number(
        (currentWeightLb - profile.startingWeightLb).toFixed(1)
      );

      const titration = evaluateTitrationRecommendation(profile.medicationLogs[0]);

      const dashboardData = {
        profile: {
          id: profile.id,
          heightInches: profile.heightInches,
          startingWeightLb: profile.startingWeightLb,
          currentWeightLb,
          goalWeightLb: profile.goalWeightLb,
          currentBmi,
          totalWeightChangeLb,
        },
        latestIntake: profile.intakes[0] ?? null,
        titration,
        medicationLogs: profile.medicationLogs,
        biometrics: profile.biometrics,
      };

      // 3. Populate Redis Cache with 60-second TTL
      try {
        await redis.setex(
          cacheKey,
          DASHBOARD_CACHE_TTL_SECONDS,
          JSON.stringify(dashboardData)
        );
      } catch {
        // Non-fatal if Redis write fails
      }

      await recordAuditLog(userId, "VIEW_PATIENT_DASHBOARD", profile.id, req.ip);

      res.status(200).json({
        cacheSource: "POSTGRES_MISS",
        data: dashboardData,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to load patient dashboard",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

const BiometricSubmissionSchema = z.object({
  weightLb: z.number().min(70).max(800),
  proteinGrams: z.number().int().min(0).max(500).optional(),
  waterOunces: z.number().int().min(0).max(300).optional(),
});

/**
 * POST /api/patient/biometrics
 * Records a new weight/nutrition check-in and invalidates the Redis dashboard cache.
 */
patientRouter.post(
  "/biometrics",
  requireAuth,
  requireRole(["PATIENT"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = BiometricSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid biometric entry",
          issues: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const userId = req.user!.userId;
      const profile = await prisma.patientProfile.findUnique({ where: { userId } });
      if (!profile) {
        res.status(404).json({ error: "Patient profile not found" });
        return;
      }

      const entry = await prisma.biometricEntry.create({
        data: {
          patientProfileId: profile.id,
          weightLb: parsed.data.weightLb,
          proteinGrams: parsed.data.proteinGrams ?? 100,
          waterOunces: parsed.data.waterOunces ?? 80,
        },
      });

      // Cache Invalidation: Evict stale dashboard snapshot from Redis
      try {
        await redis.del(getDashboardCacheKey(userId));
      } catch {
        // Ignore Redis eviction errors
      }

      await recordAuditLog(userId, "LOG_BIOMETRIC_ENTRY", entry.id, req.ip);

      res.status(201).json({
        message: "Biometric entry recorded and dashboard cache invalidated.",
        entry,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to record biometric entry",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);

const MedicationLogSubmissionSchema = z.object({
  dosageMg: z.number().refine(
    (val) =>
      (SEMAGLUTIDE_TITRATION_LADDER_MG as readonly number[]).includes(val),
    { message: "Dosage must match a valid Semaglutide titration step (0.25, 0.5, 1.0, 1.7, 2.4 mg)" }
  ),
  weekNumber: z.number().int().min(1).max(104),
  sideEffects: z.array(z.string()).default(["NONE"]),
});

/**
 * POST /api/patient/medication-log
 * Logs a weekly GLP-1 injection and invalidates the Redis dashboard cache.
 */
patientRouter.post(
  "/medication-log",
  requireAuth,
  requireRole(["PATIENT"]),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const parsed = MedicationLogSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid medication log payload",
          issues: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const userId = req.user!.userId;
      const profile = await prisma.patientProfile.findUnique({ where: { userId } });
      if (!profile) {
        res.status(404).json({ error: "Patient profile not found" });
        return;
      }

      const log = await prisma.medicationLog.create({
        data: {
          patientProfileId: profile.id,
          medicationName: "Semaglutide (GLP-1 RA)",
          dosageMg: parsed.data.dosageMg,
          weekNumber: parsed.data.weekNumber,
          sideEffects: parsed.data.sideEffects,
        },
      });

      // Cache Invalidation: Evict stale dashboard snapshot from Redis
      try {
        await redis.del(getDashboardCacheKey(userId));
      } catch {
        // Ignore Redis eviction errors
      }

      await recordAuditLog(userId, "LOG_MEDICATION_DOSE", log.id, req.ip);

      res.status(201).json({
        message: "Weekly GLP-1 dose logged and dashboard cache invalidated.",
        log,
      });
    } catch (error) {
      res.status(500).json({
        error: "Failed to log medication dose",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
);