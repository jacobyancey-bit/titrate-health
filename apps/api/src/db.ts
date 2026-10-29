/**
 * @fileoverview Database Connection Pool Singleton.
 *
 * Architectural Role:
 * Instantiates a single shared `PrismaClient` instance across the entire Express
 * application. Creating multiple `PrismaClient` instances inside individual route
 * handlers would exhaust PostgreSQL's connection pool under concurrent load.
 */

import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();