/**
 * @fileoverview Main Express Application Entrypoint for `@titrate-health/api`.
 *
 * Responsibilities:
 * 1. Loads environment variables from `apps/api/.env`.
 * 2. Configures global HTTP middleware (CORS & JSON payload parsing).
 * 3. Exposes an infrastructure `/api/health` readiness probe verifying PostgreSQL connectivity.
 * 4. Exposes a `/api/auth/demo-token` endpoint for generating signed RBAC JWTs (`PATIENT` / `CLINICIAN`).
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { prisma } from "./db.js";
import { requireAuth, requireRole } from "./middleware/auth.js";
import { intakeRouter } from "./routes/intake.js";

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-fallback-secret";

// ============================================================================
// 1. GLOBAL MIDDLEWARE PIPELINE
// ============================================================================

/**
 * Enable Cross-Origin Resource Sharing (CORS) so the Next.js frontend
 * (running on port 3000) is permitted by the browser to call this API (port 4000).
 */
app.use(cors());

/**
 * Parse incoming `Content-Type: application/json` payloads into `req.body`.
 * Limits payload size to 100kb to prevent memory-exhaustion Denial of Service (DoS) attacks.
 */
app.use(express.json({ limit: "100kb" }));

// ============================================================================
// 2. INFRASTRUCTURE & AUTHENTICATION ROUTES
// ============================================================================

/**
 * GET /api/health
 * Infrastructure readiness probe used by load balancers (AWS ALB / Kubernetes).
 * Executes a lightweight `SELECT 1` query to verify PostgreSQL connection pool health.
 */
app.get("/api/health", async (_req: Request, res: Response) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: "healthy",
      service: "@titrate-health/api",
      database: "connected",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      status: "unhealthy",
      database: "disconnected",
      error: error instanceof Error ? error.message : "Unknown database error",
    });
  }
});

/**
 * POST /api/auth/demo-token
 * Upserts a demo User (`PATIENT` or `CLINICIAN`) in PostgreSQL and returns a signed
 * JWT Bearer token valid for 8 hours so we can test RBAC-protected clinical endpoints.
 */
app.post("/api/auth/demo-token", async (req: Request, res: Response) => {
  try {
    const requestedRole: Role =
      req.body?.role === "CLINICIAN" ? "CLINICIAN" : "PATIENT";
    const email =
      requestedRole === "CLINICIAN"
        ? "dr.sarah.chen@titratehealth.com"
        : "alex.rivera@patient.com";

    // Upsert (Update if exists, Insert if new) the user in PostgreSQL
    const user = await prisma.user.upsert({
      where: { email },
      update: { role: requestedRole },
      create: {
        email,
        passwordHash: "demo_argon2_hash_placeholder",
        role: requestedRole,
      },
    });

    // If this user is a PATIENT, ensure they also have a 1:1 PatientProfile row
    if (requestedRole === "PATIENT") {
      await prisma.patientProfile.upsert({
        where: { userId: user.id },
        update: {},
        create: {
          userId: user.id,
          dateOfBirth: new Date("1988-05-14"),
          heightInches: 68,
          startingWeightLb: 215,
          goalWeightLb: 165,
        },
      });
    }

    // Sign a stateless JWT containing the user's UUID and Role
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.status(200).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    });
  } catch (error) {
    res.status(500).json({
      error: "Failed to issue demo token",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/clinician/verify-access
 * Example RBAC-protected endpoint that ONLY permits users with the `CLINICIAN` role.
 * Demonstrates the `requireAuth` -> `requireRole(['CLINICIAN'])` middleware chain.
 */
app.get(
  "/api/clinician/verify-access",
  requireAuth,
  requireRole(["CLINICIAN"]),
  (req: Request, res: Response) => {
    res.status(200).json({
      message: "Clinician RBAC verification passed.",
      authenticatedUser: req.user,
    });
  }
);
app.use("/api/intake", intakeRouter);

// ============================================================================
// 3. START HTTP SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`🚀 Titrate-Health API running on http://localhost:${PORT}`);
  console.log(`🩺 Health Check: http://localhost:${PORT}/api/health`);
});