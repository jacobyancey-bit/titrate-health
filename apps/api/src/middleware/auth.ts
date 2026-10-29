/**
 * @fileoverview Authentication, Role-Based Access Control (RBAC), and HIPAA Audit Middleware.
 *
 * Security Pipeline:
 * 1. `requireAuth` (HTTP 401): Verifies identity via stateless JWT Bearer token.
 * 2. `requireRole` (HTTP 403): Enforces role permissions (`PATIENT`, `CLINICIAN`, `CARE_COORDINATOR`).
 * 3. `recordAuditLog`: Writes an immutable HIPAA compliance trail whenever PHI is accessed or mutated.
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";
import { prisma } from "../db.js";

/**
 * Decoded JWT payload attached to `req.user` after successful authentication.
 */
export interface AuthUser {
  userId: string;
  role: Role;
}

/**
 * TypeScript Module Augmentation:
 * Extends the global Express `Request` interface so downstream route handlers
 * have compile-time type safety when accessing `req.user`.
 */
declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || "dev-fallback-secret";

/**
 * Express middleware that authenticates incoming HTTP requests via the
 * `Authorization: Bearer <token>` header.
 *
 * - Returns `401 Unauthorized` if the token is missing, malformed, or expired.
 * - Attaches the decoded `{ userId, role }` payload to `req.user` on success.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  // Verify the Authorization header exists and follows the "Bearer <token>" standard
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required: Missing Bearer token" });
    return;
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    res.status(401).json({ error: "Authentication required: Malformed token" });
    return;
  }

  try {
    // Cryptographically verify token signature and expiration against JWT_SECRET
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Higher-order Express middleware factory that enforces Role-Based Access Control (RBAC).
 * Must be placed AFTER `requireAuth` in the route middleware chain.
 *
 * - Returns `401 Unauthorized` if `req.user` is not populated.
 * - Returns `403 Forbidden` if the authenticated user's role is not in `allowedRoles`.
 *
 * @param allowedRoles - Array of Prisma `Role` enums permitted to access the route.
 */
export function requireRole(allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: `Forbidden: Requires one of [${allowedRoles.join(", ")}] role`,
      });
      return;
    }

    next();
  };
}

/**
 * Persists an immutable HIPAA audit log entry in PostgreSQL whenever Protected
 * Health Information (PHI) is viewed, created, or modified.
 *
 * @param actorId - UUID of the authenticated `User` performing the action.
 * @param action - Standardized uppercase verb describing the event (e.g., `"APPROVE_TITRATION"`).
 * @param targetResourceId - UUID of the `PatientProfile` or clinical record being accessed.
 * @param ipAddress - Originating client IP address for security forensics.
 */
export async function recordAuditLog(
  actorId: string,
  action: string,
  targetResourceId: string,
  ipAddress?: string
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId,
      action,
      targetResourceId,
      ipAddress: ipAddress ?? "unknown",
    },
  });
}