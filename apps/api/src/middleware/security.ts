/**
 * @fileoverview Production Security Primitives: Cryptographic Password Hashing (scrypt),
 * OWASP HTTP Security Headers, and Brute-Force Rate Limiting Middleware.
 *
 * Why Native `node:crypto` (`scrypt`) Instead of `bcrypt`?
 * - `scrypt` is a memory-hard Key Derivation Function (KDF) standardized in RFC 7914
 *   and built directly into Node.js's OpenSSL bindings.
 * - Eliminates native C++ addon compilation failures (`node-gyp`) in Alpine Docker containers
 *   and avoids third-party supply-chain vulnerabilities.
 * - Uses `timingSafeEqual` during password comparison to prevent Timing Side-Channel Attacks.
 */

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { Request, Response, NextFunction } from "express";

const SALT_BYTES = 16;
const KEY_LENGTH_BYTES = 64;

/**
 * Hashes a plaintext password using a unique 16-byte cryptographic salt and `scrypt`.
 *
 * Format stored in PostgreSQL `User.passwordHash`: `<saltHex>:<derivedKeyHex>`
 * Because every user receives a unique random salt, two users with the same password
 * produce completely different hashes (defeating precomputed Rainbow Table attacks).
 */
export function hashPassword(plaintextPassword: string): string {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const derivedKey = scryptSync(plaintextPassword, salt, KEY_LENGTH_BYTES).toString("hex");
  return `${salt}:${derivedKey}`;
}

/**
 * Verifies a plaintext password against a stored `<saltHex>:<derivedKeyHex>` hash
 * using constant-time byte comparison (`timingSafeEqual`).
 */
export function verifyPassword(plaintextPassword: string, storedHash: string): boolean {
  const parts = storedHash.split(":");
  if (parts.length !== 2) return false;

  const [salt, originalKeyHex] = parts;
  if (!salt || !originalKeyHex) return false;

  const candidateBuffer = scryptSync(plaintextPassword, salt, KEY_LENGTH_BYTES);
  const originalBuffer = Buffer.from(originalKeyHex, "hex");

  if (candidateBuffer.length !== originalBuffer.length) {
    return false;
  }

  return timingSafeEqual(candidateBuffer, originalBuffer);
}

/**
 * Express middleware that attaches OWASP-recommended HTTP security headers to every response
 * and strips framework fingerprinting headers (`X-Powered-By`).
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"
  );
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  );
  next();
}

/**
 * Creates a fixed-window IP rate-limiting middleware to protect authentication and
 * clinical endpoints from brute-force credential stuffing and DoS floods.
 * Returns `HTTP 429 Too Many Requests` when exceeded.
 */
export function createRateLimiter(maxRequests = 100, windowMs = 60_000) {
  const ipHits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const record = ipHits.get(clientIp);

    if (!record || now > record.resetAt) {
      ipHits.set(clientIp, { count: 1, resetAt: now + windowMs });
      res.setHeader("X-RateLimit-Limit", String(maxRequests));
      res.setHeader("X-RateLimit-Remaining", String(maxRequests - 1));
      next();
      return;
    }

    if (record.count >= maxRequests) {
      const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.setHeader("X-RateLimit-Limit", String(maxRequests));
      res.setHeader("X-RateLimit-Remaining", "0");
      res.status(429).json({
        error: "Too many requests: Rate limit exceeded",
        retryAfterSeconds,
      });
      return;
    }

    record.count += 1;
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(maxRequests - record.count));
    next();
  };
}