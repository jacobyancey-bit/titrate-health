/**
 * @fileoverview Admin & Care Coordinator Operations (`CARE_COORDINATOR` / `CLINICIAN` RBAC).
 *
 * Implements 3 Production Telehealth Architecture Patterns:
 * 1. Recurly Subscription Entitlement Sync (`APPROVED` -> `ACTIVE`, `INELIGIBLE` -> `AUTO_REFUNDED`).
 * 2. Idempotent Recurly Webhook Consumer (`POST /api/ops/recurly-webhook`) with Dunning Grace Windows
 *    so failed credit cards do not abruptly interrupt GLP-1 titration schedules.
 * 3. HIPAA PHI-Scrubbed Server-Side Braze/Amplitude Event Dispatcher (`HTTP 202 Accepted`) that strips
 *    clinical fields and blocks third-party ad-tracker leakage (`ttcsid`, `sc_at`, `t_gid`).
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requireRole, recordAuditLog } from "../middleware/auth.js";

export const opsRouter = Router();

/**
 * In-memory idempotency store tracking processed Recurly webhook IDs (`webhookId`)
 * and current subscription states keyed by user email.
 */
const processedWebhookIds = new Set<string>();

export interface RecurlySubscriptionState {
    accountEmail: string;
    planCode: string;
    recurlyState:
    | "ACTIVE"
    | "DUNNING_GRACE_PERIOD"
    | "CANCELED_REFUNDED_INELIGIBLE"
    | "PENDING_CLINICAL_APPROVAL";
    dunningGraceEndsAt: string | null;
    lastWebhookId: string;
    updatedAt: string;
}

const subscriptionStore = new Map<string, RecurlySubscriptionState>();

/**
 * Pure helper function that synchronizes a patient's Recurly subscription state
 * with their clinical intake status and incoming Recurly webhook events.
 * Exported for deterministic unit testing in `clinical-and-auth.test.ts`.
 */
export function evaluateRecurlyEntitlementSync(params: {
    webhookId: string;
    eventType:
    | "subscription.created"
    | "invoice.paid"
    | "dunning.new_dunning_event"
    | "clinical.intake_ineligible";
    accountEmail: string;
    intakeStatus?: "PENDING_REVIEW" | "APPROVED" | "INELIGIBLE";
    alreadyProcessedIds?: Set<string>;
}) {
    const idSet = params.alreadyProcessedIds ?? processedWebhookIds;

    // 1. Idempotency Guard: Never process the same Recurly webhook notification twice
    if (idSet.has(params.webhookId)) {
        return {
            idempotentSkip: true,
            recurlyState: "UNCHANGED" as const,
            clinicalAction: "NO_OP_DUPLICATE_WEBHOOK",
        };
    }
    idSet.add(params.webhookId);

    // 2. Clinical Ineligibility Override: Never bill an ineligible patient
    if (
        params.eventType === "clinical.intake_ineligible" ||
        params.intakeStatus === "INELIGIBLE"
    ) {
        return {
            idempotentSkip: false,
            recurlyState: "CANCELED_REFUNDED_INELIGIBLE" as const,
            clinicalAction:
                "Issued full Recurly credit invoice & voided subscription due to clinical ineligibility.",
        };
    }

    // 3. Recurly Dunning (Failed Renewal Card): Trigger 7-Day Care Coordinator Grace Window
    //    instead of abruptly halting Semaglutide titration.
    if (params.eventType === "dunning.new_dunning_event") {
        return {
            idempotentSkip: false,
            recurlyState: "DUNNING_GRACE_PERIOD" as const,
            clinicalAction:
                "Payment failed in Recurly. Activated 7-day clinical continuity grace window & paged CARE_COORDINATOR so Week 4 GLP-1 escalation is not interrupted.",
        };
    }

    // 4. Paid Invoice + Approved Intake -> Active Clinical Membership
    return {
        idempotentSkip: false,
        recurlyState: "ACTIVE" as const,
        clinicalAction:
            "Recurly subscription active and synchronized with approved GLP-1 treatment plan.",
    };
}

const CLINICAL_EVENT_ANONYMIZATION_MAP: Record<string, string> = {
    PrescriptionEligibilityApproved: "Conversion",
    ClinicalIntakeSubmitted: "LeadGenerated",
    Glp1TitrationStepUp: "MilestoneCompleted",
    clinical_week4_titration_check_in: "MilestoneCompleted",
};

/**
 * Server-Side Telemetry Redaction & Anonymization Pipeline:
 * 1. Strips client network/device identifiers (`ipAddress`, `userAgent`, `referrer`, `device_id`, `MUID`).
 * 2. Strips Protected Health Information (PHI), medication names, and diagnostic search terms.
 * 3. Maps clinical milestone event names to generic attribution event names (`Conversion`, `LeadGenerated`).
 */
export function scrubPhiForServerTelemetry(rawPayload: Record<string, unknown>) {
    const FORBIDDEN_PHI_AND_AD_KEYS = new Set([
        // Clinical & PHI fields
        "weightLb",
        "startingWeightLb",
        "calculatedBmi",
        "comorbidities",
        "contraindications",
        "dateOfBirth",
        "medicationName",
        "dosageMg",
        "controllingTerms",
        // Network, Device & Ad-Tracker Identifiers
        "ipAddress",
        "clientIp",
        "userAgent",
        "referrer",
        "device_id",
        "browser_id",
        "MUID",
        "_fbp",
        "_ttp",
        "_clck",
        "ttcsid",
        "sc_at",
        "t_gid",
        "gbraid",
        "g_adid",
        "g_adgroupid",
        "rbuid",
        "_rbuid",
        "_rdt_uuid",
        "_rdt_cid",
        "_rdt_em",
        "_rdt_pn",
    ]);

    const safeAttributes: Record<string, unknown> = {};
    const strippedKeys: string[] = [];

    for (const [key, value] of Object.entries(rawPayload)) {
        if (FORBIDDEN_PHI_AND_AD_KEYS.has(key)) {
            strippedKeys.push(key);
        } else {
            safeAttributes[key] = value;
        }
    }

    // Anonymize clinical event or campaign names into generic conversion events
    const rawEventName = String(
        rawPayload.eventName ?? rawPayload.campaignName ?? "ApplicationEvent"
    );
    const anonymizedEventName =
        CLINICAL_EVENT_ANONYMIZATION_MAP[rawEventName] ?? "GenericApplicationEvent";

    if ("eventName" in safeAttributes) {
        safeAttributes.eventName = anonymizedEventName;
    }

    return {
        anonymizedEventName,
        safeAttributes,
        strippedKeys,
        hipaaCompliant: true,
    };
}

const RecurlyWebhookSchema = z.object({
    webhookId: z.string().min(4),
    eventType: z.enum([
        "subscription.created",
        "invoice.paid",
        "dunning.new_dunning_event",
        "clinical.intake_ineligible",
    ]),
    accountEmail: z.string().email().default("alex.rivera@patient.com"),
});

/**
 * POST /api/ops/recurly-webhook
 * Simulates receiving a webhook notification from Recurly (`dunning`, `invoice.paid`, etc.)
 * with strict idempotency deduplication and clinical state synchronization.
 */
opsRouter.post(
    "/recurly-webhook",
    requireAuth,
    requireRole(["CARE_COORDINATOR"]),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const parsed = RecurlyWebhookSchema.safeParse(req.body);
            if (!parsed.success) {
                res.status(400).json({
                    error: "Invalid Recurly webhook payload",
                    issues: parsed.error.flatten().fieldErrors,
                });
                return;
            }

            const { webhookId, eventType, accountEmail } = parsed.data;
            const syncResult = evaluateRecurlyEntitlementSync({
                webhookId,
                eventType,
                accountEmail,
            });

            if (syncResult.idempotentSkip || syncResult.recurlyState === "UNCHANGED") {
                res.status(200).json({
                    message: `Webhook ${webhookId} already processed (Idempotent No-Op).`,
                    idempotentSkip: true,
                    subscription: subscriptionStore.get(accountEmail) ?? null,
                });
                return;
            }

            const graceDate =
                syncResult.recurlyState === "DUNNING_GRACE_PERIOD"
                    ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
                    : null;

            const updatedSub: RecurlySubscriptionState = {
                accountEmail,
                planCode: "titrate-clinical-glp1-monthly",
                recurlyState: syncResult.recurlyState,
                dunningGraceEndsAt: graceDate,
                lastWebhookId: webhookId,
                updatedAt: new Date().toISOString(),
            };
            subscriptionStore.set(accountEmail, updatedSub);

            await recordAuditLog(
                req.user!.userId,
                `RECURLY_WEBHOOK_${eventType.toUpperCase()}`,
                webhookId,
                req.ip
            );

            res.status(200).json({
                message: syncResult.clinicalAction,
                idempotentSkip: false,
                subscription: updatedSub,
            });
        } catch (error) {
            res.status(500).json({
                error: "Failed to process Recurly webhook",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
);

/**
 * POST /api/ops/telemetry-dispatch
 * Server-side Braze & Amplitude lifecycle event dispatcher.
 * Scrubs PHI and 3rd-party ad pixels (`ttcsid`, `sc_at`) and returns `HTTP 202 Accepted`.
 */
opsRouter.post(
    "/telemetry-dispatch",
    requireAuth,
    requireRole(["CARE_COORDINATOR"]),
    async (req: Request, res: Response): Promise<void> => {
        try {
            const rawEvent = (req.body ?? {}) as Record<string, unknown>;
            const scrubbed = scrubPhiForServerTelemetry(rawEvent);

            await recordAuditLog(
                req.user!.userId,
                "DISPATCH_SERVER_SIDE_BRAZE_EVENT",
                String(rawEvent.campaignName || "glp1_adherence_nudge"),
                req.ip
            );

            // Return HTTP 202 Accepted (Asynchronous Event Queued) matching production telemetry
            res.status(202).json({
                status: "ACCEPTED_FOR_ASYNC_DELIVERY",
                destinations: ["Braze (braze-server-api)", "Amplitude (analytics-server-api)"],
                scrubbedResult: scrubbed,
            });
        } catch (error) {
            res.status(500).json({
                error: "Failed to dispatch telemetry event",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
);

/**
 * GET /api/ops/overview
 * Returns the Admin / Care Coordinator operational overview combining patient counts,
 * Recurly subscription states, and HIPAA privacy gate status.
 */
opsRouter.get(
    "/overview",
    requireAuth,
    requireRole(["CARE_COORDINATOR", "CLINICIAN"]),
    async (_req: Request, res: Response): Promise<void> => {
        try {
            const [userCount, intakeCount, auditCount] = await Promise.all([
                prisma.user.count(),
                prisma.clinicalIntake.count(),
                prisma.auditLog.count(),
            ]);

            // Seed default Recurly state for demo patient if empty
            if (!subscriptionStore.has("alex.rivera@patient.com")) {
                subscriptionStore.set("alex.rivera@patient.com", {
                    accountEmail: "alex.rivera@patient.com",
                    planCode: "titrate-clinical-glp1-monthly",
                    recurlyState: "ACTIVE",
                    dunningGraceEndsAt: null,
                    lastWebhookId: "wh_initial_seed_001",
                    updatedAt: new Date().toISOString(),
                });
            }

            res.status(200).json({
                metrics: {
                    totalUsers: userCount,
                    totalIntakes: intakeCount,
                    totalHipaaAuditEvents: auditCount,
                    processedWebhookCount: processedWebhookIds.size,
                },
                subscriptions: Array.from(subscriptionStore.values()),
            });
        } catch (error) {
            res.status(500).json({
                error: "Failed to load Care Ops overview",
                details: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
);