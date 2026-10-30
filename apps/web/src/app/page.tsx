"use client";

/**
 * @fileoverview Main Interactive Member Telemetry, Clinician Triage & Care Ops Portal.
 *
 * Architectural Highlights:
 * 1. Domain-Driven Design (DDD) Bounded Contexts: Surfaces "Member" in the subscription/UI
 *    layer while mapping 1:1 to `PatientProfile` (`PATIENT` RBAC role) in PostgreSQL.
 * 2. Authenticates all 3 RBAC personas (`PATIENT`, `CLINICIAN`, `CARE_COORDINATOR`).
 * 3. Visualizes Redis Cache-Aside state (`REDIS_HIT` vs `POSTGRES_MISS`) in real time.
 * 4. Care Ops Admin View (`CARE_COORDINATOR`): Interactive Recurly Webhook Idempotency &
 *    Dunning Grace simulator + HIPAA PHI-Scrubbed Server-Side Braze/Amplitude (`202 Accepted`) dispatcher.
 */

import React, { useEffect, useState, useCallback } from "react";
import {
  SEMAGLUTIDE_TITRATION_LADDER_MG,
  COMORBIDITIES,
  CONTRAINDICATIONS,
  calculateBmi,
} from "@titrate-health/shared";
import {
  Activity,
  ShieldCheck,
  Database,
  Zap,
  Stethoscope,
  UserCheck,
  Scale,
  Syringe,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  CreditCard,
  Radio,
} from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type Role = "PATIENT" | "CLINICIAN" | "CARE_COORDINATOR";

export default function TitrateHealthPortal() {
  const [role, setRole] = useState<Role>("PATIENT");
  const [token, setToken] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [statusBanner, setStatusBanner] = useState<string>("");

  // Member (PATIENT) Dashboard State
  const [cacheSource, setCacheSource] = useState<"REDIS_HIT" | "POSTGRES_MISS" | null>(null);
  const [dashboard, setDashboard] = useState<any>(null);

  // Member Telemetry Forms State
  const [weightInput, setWeightInput] = useState<number>(208.0);
  const [proteinInput, setProteinInput] = useState<number>(120);
  const [waterInput, setWaterInput] = useState<number>(90);

  const [doseInput, setDoseInput] = useState<number>(0.25);
  const [weekInput, setWeekInput] = useState<number>(4);
  const [sideEffectInput, setSideEffectInput] = useState<string>("NONE");

  const [intakeHeight, setIntakeHeight] = useState<number>(68);
  const [intakeWeight, setIntakeWeight] = useState<number>(215);
  const [selectedComorbidities, setSelectedComorbidities] = useState<string[]>(["HYPERTENSION"]);
  const [selectedContraindications, setSelectedContraindications] = useState<string[]>([]);

  // Clinician Queue & HIPAA Audit State
  const [intakeQueue, setIntakeQueue] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);

  // Care Ops Admin (Recurly & Braze/Amplitude) State
  const [opsOverview, setOpsOverview] = useState<any>(null);
  const [lastWebhookId, setLastWebhookId] = useState<string>("recurly_wh_2026_001");
  const [telemetryResult, setTelemetryResult] = useState<any>(null);

  /**
   * 1. Authenticate with the Express API for the selected RBAC persona.
   */
  const authenticateRole = useCallback(async (targetRole: Role) => {
    setLoading(true);
    setStatusBanner("");
    try {
      const res = await fetch(`${API_BASE}/api/auth/demo-token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: targetRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to authenticate");

      setToken(data.token);
      setUserEmail(data.user.email);
      setRole(targetRole);

      if (targetRole === "PATIENT") {
        await fetchPatientDashboard(data.token);
      } else if (targetRole === "CLINICIAN") {
        await fetchClinicianQueue(data.token);
      } else {
        await fetchOpsOverview(data.token);
      }
    } catch (err: any) {
      setStatusBanner(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * 2. Fetch Member Dashboard (demonstrates Redis Cache-Aside: REDIS_HIT vs POSTGRES_MISS).
   */
  const fetchPatientDashboard = async (jwtToken = token) => {
    const res = await fetch(`${API_BASE}/api/patient/dashboard`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    const payload = await res.json();
    if (res.ok) {
      setCacheSource(payload.cacheSource);
      setDashboard(payload.data);
    }
  };

  /**
   * 3. Fetch Clinician Intake Triage Queue & HIPAA Audit Logs in parallel.
   */
  const fetchClinicianQueue = async (jwtToken = token) => {
    const [queueRes, auditRes] = await Promise.all([
      fetch(`${API_BASE}/api/intake/queue`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
      }),
      fetch(`${API_BASE}/api/intake/audit-logs`, {
        headers: { Authorization: `Bearer ${jwtToken}` },
      }),
    ]);
    if (queueRes.ok) {
      const payload = await queueRes.json();
      setIntakeQueue(payload.intakes || []);
    }
    if (auditRes.ok) {
      const auditPayload = await auditRes.json();
      setAuditLogs(auditPayload.logs || []);
    }
  };

  /**
   * 4. Fetch Care Coordinator Admin Ops Overview (Recurly & HIPAA Metrics).
   */
  const fetchOpsOverview = async (jwtToken = token) => {
    const res = await fetch(`${API_BASE}/api/ops/overview`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    if (res.ok) {
      const payload = await res.json();
      setOpsOverview(payload);
    }
  };

  useEffect(() => {
    authenticateRole("PATIENT");
  }, [authenticateRole]);

  const handleLogBiometrics = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(`${API_BASE}/api/patient/biometrics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        weightLb: Number(weightInput),
        proteinGrams: Number(proteinInput),
        waterOunces: Number(waterInput),
      }),
    });
    const data = await res.json();
    setStatusBanner(data.message || data.error);
    await fetchPatientDashboard();
  };

  const handleLogMedication = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(`${API_BASE}/api/patient/medication-log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        dosageMg: Number(doseInput),
        weekNumber: Number(weekInput),
        sideEffects: [sideEffectInput],
      }),
    });
    const data = await res.json();
    setStatusBanner(data.message || data.error);
    await fetchPatientDashboard();
  };

  const handleSubmitIntake = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch(`${API_BASE}/api/intake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        heightInches: Number(intakeHeight),
        weightLb: Number(intakeWeight),
        goalWeightLb: 165,
        comorbidities: selectedComorbidities,
        contraindications: selectedContraindications,
      }),
    });
    const data = await res.json();
    setStatusBanner(data.message || data.error);
    await fetchPatientDashboard();
  };

  const handleClinicianDecision = async (
    intakeId: string,
    decision: "APPROVED" | "INELIGIBLE"
  ) => {
    const res = await fetch(`${API_BASE}/api/intake/${intakeId}/review`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        status: decision,
        clinicianNotes:
          decision === "APPROVED"
            ? "Approved by Clinician via Triage Portal. Initiating Week 1 Semaglutide 0.25mg."
            : "Flagged clinically ineligible during clinician review.",
      }),
    });
    const data = await res.json();
    setStatusBanner(data.message || data.error);
    await fetchClinicianQueue();
  };

  /**
   * Simulate a Recurly Webhook event (`invoice.paid`, `dunning.new_dunning_event`, etc.)
   */
  const handleTriggerRecurlyWebhook = async (
    eventType:
      | "invoice.paid"
      | "dunning.new_dunning_event"
      | "clinical.intake_ineligible",
    reuseLastId = false
  ) => {
    const webhookId = reuseLastId
      ? lastWebhookId
      : `recurly_wh_${Math.floor(1000 + Math.random() * 9000)}`;
    setLastWebhookId(webhookId);

    const res = await fetch(`${API_BASE}/api/ops/recurly-webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        webhookId,
        eventType,
        accountEmail: "alex.rivera@patient.com",
      }),
    });
    const data = await res.json();
    setStatusBanner(data.message || data.error);
    await fetchOpsOverview();
  };

  /**
   * Dispatch a Server-Side Braze & Amplitude Event (`HTTP 202 Accepted`) with PHI Scrubbing.
   */
  const handleDispatchServerTelemetry = async () => {
    const res = await fetch(`${API_BASE}/api/ops/telemetry-dispatch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        campaignName: "med_plus_week4_titration_check_in",
        memberEmail: "alex.rivera@patient.com",
        subscriptionTier: "ww-med-plus-glp1",
        // Simulated PHI & 3rd-party Ad Cookies that MUST be stripped by the server scrubber:
        weightLb: 209.4,
        calculatedBmi: 31.8,
        comorbidities: ["HYPERTENSION"],
        ttcsid: "1793396509877::tiktok_pixel_id",
        sc_at: "v2|snapchat_ad_cookie",
        t_gid: "taboola_ad_id",
      }),
    });
    const data = await res.json();
    setTelemetryResult({ httpStatus: res.status, ...data });
    setStatusBanner(
      `HTTP ${res.status} Accepted: Scrubbed ${data.scrubbedResult?.strippedKeys?.length} PHI & Ad-Pixel keys before Braze/Amplitude dispatch!`
    );
    await fetchOpsOverview();
  };

  const toggleItem = (list: string[], item: string, setter: (v: string[]) => void) => {
    setter(list.includes(item) ? list.filter((i) => i !== item) : [...list, item]);
  };

  const previewBmi = calculateBmi(intakeWeight || 200, intakeHeight || 68);

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100">
      {/* Top Clinical Navigation Bar */}
      <header className="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">
                  Titrate-Health
                </h1>
                <span className="text-[11px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  GLP-1 Med+ Telemetry & RBAC
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Signed in as{" "}
                <span className="text-slate-200 font-mono">{userEmail || "..."}</span> (
                <span className="text-emerald-400 font-mono">{role}</span>)
              </p>
            </div>
          </div>

          {/* 3-Persona RBAC Switcher + Redis Cache Status */}
          <div className="flex flex-wrap items-center gap-3">
            {role === "PATIENT" && cacheSource && (
              <button
                onClick={() => fetchPatientDashboard()}
                title="Click to re-fetch dashboard and observe Redis Cache Hit!"
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono border transition ${
                  cacheSource === "REDIS_HIT"
                    ? "bg-amber-500/15 border-amber-500/40 text-amber-300"
                    : "bg-sky-500/15 border-sky-500/40 text-sky-300"
                }`}
              >
                {cacheSource === "REDIS_HIT" ? (
                  <Zap className="h-3.5 w-3.5 text-amber-400" />
                ) : (
                  <Database className="h-3.5 w-3.5 text-sky-400" />
                )}
                {cacheSource}
                <RefreshCw className="h-3 w-3 ml-1 opacity-70" />
              </button>
            )}

            <div className="inline-flex rounded-xl bg-slate-900 p-1 border border-slate-800">
              <button
                onClick={() => authenticateRole("PATIENT")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  role === "PATIENT"
                    ? "bg-emerald-500 text-slate-950 shadow"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <UserCheck className="h-3.5 w-3.5" />
                Member View (PATIENT)
              </button>
              <button
                onClick={() => authenticateRole("CLINICIAN")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  role === "CLINICIAN"
                    ? "bg-indigo-500 text-white shadow"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <Stethoscope className="h-3.5 w-3.5" />
                Clinician Triage
              </button>
              <button
                onClick={() => authenticateRole("CARE_COORDINATOR")}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${
                  role === "CARE_COORDINATOR"
                    ? "bg-amber-500 text-slate-950 shadow"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <CreditCard className="h-3.5 w-3.5" />
                Care Ops Admin (Recurly & Braze)
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Live Feedback Banner */}
        {statusBanner && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-400 shrink-0" />
              <span>{statusBanner}</span>
            </div>
            <button
              onClick={() => setStatusBanner("")}
              className="text-xs text-emerald-300 hover:underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {loading ? (
          <div className="p-12 text-center text-slate-400 animate-pulse">
            Loading clinical telemetry from PostgreSQL & Redis...
          </div>
        ) : role === "PATIENT" && dashboard ? (
          <>
            {/* 1. Member KPI Summary Row */}
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-5">
                <p className="text-xs uppercase tracking-wider text-slate-400">
                  Member Current Weight
                </p>
                <p className="text-3xl font-bold text-white mt-1">
                  {dashboard.profile.currentWeightLb}{" "}
                  <span className="text-base font-normal text-slate-400">lbs</span>
                </p>
                <p className="text-xs text-emerald-400 mt-2">
                  Start: {dashboard.profile.startingWeightLb} lbs • Goal:{" "}
                  {dashboard.profile.goalWeightLb} lbs
                </p>
              </div>

              <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-5">
                <p className="text-xs uppercase tracking-wider text-slate-400">
                  Net Weight Change
                </p>
                <p className="text-3xl font-bold text-emerald-400 mt-1">
                  {dashboard.profile.totalWeightChangeLb > 0 ? "+" : ""}
                  {dashboard.profile.totalWeightChangeLb}{" "}
                  <span className="text-base font-normal text-slate-400">lbs</span>
                </p>
                <p className="text-xs text-slate-400 mt-2">
                  Tracked across {dashboard.biometrics.length} member check-ins
                </p>
              </div>

              <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-5">
                <p className="text-xs uppercase tracking-wider text-slate-400">
                  Current BMI (@titrate-health/shared)
                </p>
                <p className="text-3xl font-bold text-white mt-1">
                  {dashboard.profile.currentBmi}
                </p>
                <p className="text-xs text-slate-400 mt-2">
                  Height: {dashboard.profile.heightInches} inches
                </p>
              </div>

              <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-5">
                <p className="text-xs uppercase tracking-wider text-slate-400">
                  Clinical Intake Status
                </p>
                <p className="text-xl font-bold text-white mt-2">
                  {dashboard.latestIntake?.status || "NOT_SUBMITTED"}
                </p>
                <p className="text-xs text-slate-400 mt-2 truncate">
                  {dashboard.latestIntake?.clinicianNotes ||
                    "Submit intake below for clinician triage"}
                </p>
              </div>
            </section>

            {/* 2. FDA Semaglutide Titration State Machine Ladder */}
            <section className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Syringe className="h-4 w-4 text-emerald-400" />
                    GLP-1 Titration Escalation State Machine (Semaglutide)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {dashboard.titration.clinicalRationale}
                  </p>
                </div>
                <span className="px-3 py-1 rounded-full text-xs font-mono font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  {dashboard.titration.recommendationStatus}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {SEMAGLUTIDE_TITRATION_LADDER_MG.map((stepMg, idx) => {
                  const isCurrent = dashboard.titration.currentDosageMg === stepMg;
                  const isRecommended =
                    dashboard.titration.nextRecommendedDosageMg === stepMg &&
                    dashboard.titration.nextRecommendedDosageMg !==
                      dashboard.titration.currentDosageMg;

                  return (
                    <div
                      key={stepMg}
                      className={`rounded-xl p-4 border transition ${
                        isCurrent
                          ? "bg-emerald-500/15 border-emerald-500 text-white"
                          : isRecommended
                          ? "bg-indigo-500/15 border-indigo-400/70 text-indigo-200"
                          : "bg-slate-950/60 border-slate-800 text-slate-400"
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span>Step {idx + 1}</span>
                        {isCurrent && (
                          <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-emerald-500 text-slate-950">
                            Active
                          </span>
                        )}
                        {isRecommended && (
                          <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-indigo-500 text-white">
                            Next Step
                          </span>
                        )}
                      </div>
                      <p className="text-2xl font-bold mt-2">{stepMg} mg</p>
                      <p className="text-[11px] opacity-75 mt-1">
                        Weeks {idx * 4 + 1}–{(idx + 1) * 4}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* 3. Interactive Member Telemetry Forms */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <form
                onSubmit={handleLogBiometrics}
                className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-4"
              >
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Scale className="h-4 w-4 text-sky-400" />
                  1. Log Member Biometric Check-In
                </h3>
                <div className="space-y-3 text-xs">
                  <div>
                    <label className="block text-slate-400 mb-1">Weight (lbs)</label>
                    <input
                      type="number"
                      step="0.1"
                      value={weightInput}
                      onChange={(e) => setWeightInput(Number(e.target.value))}
                      className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-white"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">Protein (g)</label>
                      <input
                        type="number"
                        value={proteinInput}
                        onChange={(e) => setProteinInput(Number(e.target.value))}
                        className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-white"
                      />
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Water (oz)</label>
                      <input
                        type="number"
                        value={waterInput}
                        onChange={(e) => setWaterInput(Number(e.target.value))}
                        className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-white"
                      />
                    </div>
                  </div>
                </div>
                <button
                  type="submit"
                  className="w-full rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold py-2.5 text-xs transition"
                >
                  Save Biometrics & Evict Redis Cache
                </button>
              </form>

              <form
                onSubmit={handleLogMedication}
                className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-4"
              >
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Syringe className="h-4 w-4 text-emerald-400" />
                  2. Log Weekly GLP-1 Injection
                </h3>
                <div className="space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-slate-400 mb-1">Dosage (mg)</label>
                      <select
                        value={doseInput}
                        onChange={(e) => setDoseInput(Number(e.target.value))}
                        className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-white"
                      >
                        {SEMAGLUTIDE_TITRATION_LADDER_MG.map((mg) => (
                          <option key={mg} value={mg}>
                            {mg} mg
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-400 mb-1">Treatment Week</label>
                      <input
                        type="number"
                        min={1}
                        max={104}
                        value={weekInput}
                        onChange={(e) => setWeekInput(Number(e.target.value))}
                        className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-white"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">
                      Reported Side Effects (Drives Escalation Hold)
                    </label>
                    <select
                      value={sideEffectInput}
                      onChange={(e) => setSideEffectInput(e.target.value)}
                      className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-white"
                    >
                      <option value="NONE">NONE (Well Tolerated)</option>
                      <option value="MILD_NAUSEA">MILD_NAUSEA (Hold Step-Up)</option>
                      <option value="GI_REFLUX">GI_REFLUX (Hold Step-Up)</option>
                      <option value="FATIGUE">FATIGUE (Hold Step-Up)</option>
                    </select>
                  </div>
                </div>
                <button
                  type="submit"
                  className="w-full rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 text-xs transition"
                >
                  Log Injection & Run State Machine
                </button>
              </form>

              <form
                onSubmit={handleSubmitIntake}
                className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-4"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-indigo-400" />
                    3. Clinical Eligibility Intake
                  </h3>
                  <span className="text-xs font-mono text-indigo-300">
                    Live BMI: {previewBmi}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block text-slate-400 mb-1">Height (in)</label>
                    <input
                      type="number"
                      value={intakeHeight}
                      onChange={(e) => setIntakeHeight(Number(e.target.value))}
                      className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Weight (lbs)</label>
                    <input
                      type="number"
                      value={intakeWeight}
                      onChange={(e) => setIntakeWeight(Number(e.target.value))}
                      className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-2 text-white"
                    />
                  </div>
                </div>

                <div className="text-xs space-y-1.5">
                  <p className="text-slate-400">Comorbidities (BMI ≥ 27 qualifier):</p>
                  <div className="flex flex-wrap gap-1.5">
                    {COMORBIDITIES.slice(0, 3).map((item) => (
                      <button
                        type="button"
                        key={item}
                        onClick={() =>
                          toggleItem(selectedComorbidities, item, setSelectedComorbidities)
                        }
                        className={`px-2 py-1 rounded text-[11px] border ${
                          selectedComorbidities.includes(item)
                            ? "bg-indigo-500/20 border-indigo-400 text-indigo-200"
                            : "bg-slate-950 border-slate-800 text-slate-400"
                        }`}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="text-xs space-y-1.5">
                  <p className="text-slate-400">
                    Absolute Contraindications (Auto-Ineligible):
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {CONTRAINDICATIONS.slice(0, 2).map((item) => (
                      <button
                        type="button"
                        key={item}
                        onClick={() =>
                          toggleItem(
                            selectedContraindications,
                            item,
                            setSelectedContraindications
                          )
                        }
                        className={`px-2 py-1 rounded text-[11px] border ${
                          selectedContraindications.includes(item)
                            ? "bg-rose-500/20 border-rose-400 text-rose-200"
                            : "bg-slate-950 border-slate-800 text-slate-400"
                        }`}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="submit"
                  className="w-full rounded-xl bg-indigo-500 hover:bg-indigo-400 text-white font-semibold py-2.5 text-xs transition"
                >
                  Submit Intake to ACID Transaction
                </button>
              </form>
            </section>
          </>
        ) : role === "CLINICIAN" ? (
          /* CLINICIAN RBAC TRIAGE VIEW */
          <>
            <section className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Stethoscope className="h-4 w-4 text-indigo-400" />
                    Clinician Intake Triage Queue (RBAC Protected: CLINICIAN Role Only)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Approving a Member intake executes a Prisma ACID transaction that updates
                    intake status, seeds Week 1 Semaglutide (0.25mg), and writes a HIPAA AuditLog.
                  </p>
                </div>
                <span className="text-xs font-mono px-3 py-1 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30">
                  {intakeQueue.length} Intakes
                </span>
              </div>

              <div className="space-y-3">
                {intakeQueue.map((item) => (
                  <div
                    key={item.id}
                    className="rounded-xl bg-slate-950/80 border border-slate-800 p-4 flex flex-wrap items-center justify-between gap-4"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-white">
                          {item.patientProfile?.user?.email || "Member"}
                        </span>
                        <span
                          className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                            item.status === "APPROVED"
                              ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                              : item.status === "INELIGIBLE"
                              ? "bg-rose-500/15 text-rose-300 border border-rose-500/30"
                              : "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                          }`}
                        >
                          {item.status}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400">
                        Calculated BMI:{" "}
                        <strong className="text-slate-200">{item.calculatedBmi}</strong> •
                        Comorbidities:{" "}
                        <span className="text-slate-300">
                          {item.comorbidities?.join(", ") || "None"}
                        </span>{" "}
                        • Contraindications:{" "}
                        <span className="text-rose-300">
                          {item.contraindications?.join(", ") || "None"}
                        </span>
                      </p>
                      {item.clinicianNotes && (
                        <p className="text-xs text-slate-400 italic">
                          “{item.clinicianNotes}”
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleClinicianDecision(item.id, "APPROVED")}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold text-xs transition"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Approve (Start 0.25mg)
                      </button>
                      <button
                        onClick={() => handleClinicianDecision(item.id, "INELIGIBLE")}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/40 font-semibold text-xs transition"
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Flag Ineligible
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* LIVE HIPAA IMMUTABLE AUDIT TRAIL */}
            <section className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    Immutable HIPAA Compliance Audit Trail (PostgreSQL AuditLog)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Every PHI read and clinical mutation is permanently recorded with Actor UUID, Role, Action, Target Resource, and Timestamp.
                  </p>
                </div>
                <span className="text-xs font-mono px-3 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  Last {auditLogs.length} Events
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-slate-400 uppercase tracking-wider text-[11px]">
                      <th className="py-2.5 px-3">Timestamp</th>
                      <th className="py-2.5 px-3">Actor</th>
                      <th className="py-2.5 px-3">Role</th>
                      <th className="py-2.5 px-3">HIPAA Audited Action</th>
                      <th className="py-2.5 px-3">Target Resource ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    {auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-950/50">
                        <td className="py-2.5 px-3 text-slate-400">
                          {new Date(log.createdAt).toLocaleTimeString()}
                        </td>
                        <td className="py-2.5 px-3 text-slate-200">
                          {log.actor?.email || log.actorId}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[10px]">
                            {log.actor?.role || "USER"}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-emerald-300 font-semibold">
                          {log.action}
                        </td>
                        <td className="py-2.5 px-3 text-slate-400">
                          {log.targetResourceId}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : (
          /* CARE COORDINATOR / ADMIN OPS VIEW (RECURLY & SERVER-SIDE BRAZE/AMPLITUDE) */
          <>
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Card 1: Recurly Subscription Entitlement & Dunning Grace Simulator */}
              <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-5">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-white flex items-center gap-2">
                      <CreditCard className="h-4 w-4 text-amber-400" />
                      Recurly Subscription Lifecycle & Idempotent Webhook Engine
                    </h2>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Synchronizes Member Recurly billing state with clinical GLP-1 eligibility and enforces a 7-day dunning grace window.
                    </p>
                  </div>
                </div>

                {opsOverview?.subscriptions?.map((sub: any) => (
                  <div
                    key={sub.accountEmail}
                    className="rounded-xl bg-slate-950 border border-slate-800 p-4 space-y-2 text-xs font-mono"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-white font-semibold">{sub.accountEmail}</span>
                      <span
                        className={`px-2 py-0.5 rounded-full font-bold ${
                          sub.recurlyState === "ACTIVE"
                            ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                            : sub.recurlyState === "DUNNING_GRACE_PERIOD"
                            ? "bg-amber-500/15 text-amber-300 border border-amber-500/30"
                            : "bg-rose-500/15 text-rose-300 border border-rose-500/30"
                        }`}
                      >
                        {sub.recurlyState}
                      </span>
                    </div>
                    <p className="text-slate-400">Plan: {sub.planCode}</p>
                    <p className="text-slate-400">Last Webhook ID: {sub.lastWebhookId}</p>
                    {sub.dunningGraceEndsAt && (
                      <p className="text-amber-300">
                        7-Day GLP-1 Continuity Grace Ends:{" "}
                        {new Date(sub.dunningGraceEndsAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                ))}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2">
                  <button
                    onClick={() => handleTriggerRecurlyWebhook("dunning.new_dunning_event")}
                    className="rounded-xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 font-semibold py-2.5 px-3 text-xs transition"
                  >
                    1. Simulate Recurly Dunning (7-Day Grace)
                  </button>
                  <button
                    onClick={() => handleTriggerRecurlyWebhook("clinical.intake_ineligible")}
                    className="rounded-xl bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-200 font-semibold py-2.5 px-3 text-xs transition"
                  >
                    2. Simulate Clinical Ineligible (Auto-Refund)
                  </button>
                  <button
                    onClick={() => handleTriggerRecurlyWebhook("invoice.paid")}
                    className="rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 font-semibold py-2.5 px-3 text-xs transition"
                  >
                    3. Simulate Recurly Invoice Paid (Active)
                  </button>
                  <button
                    onClick={() => handleTriggerRecurlyWebhook("invoice.paid", true)}
                    className="rounded-xl bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/40 text-indigo-200 font-semibold py-2.5 px-3 text-xs transition"
                  >
                    4. Replay Same Webhook ID (Idempotency Test)
                  </button>
                </div>
              </div>

              {/* Card 2: HIPAA PHI-Scrubbed Server-Side Braze & Amplitude Dispatcher */}
              <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-5">
                <div>
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Radio className="h-4 w-4 text-emerald-400" />
                    Server-Side Braze & Amplitude PHI Firewall (HTTP 202 Accepted)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Prevents client-side `(blocked:other)` ad-blocker failures and scrubs PHI (`weightLb`, `calculatedBmi`) + 3rd-party ad cookies (`ttcsid`, `sc_at`, `t_gid`) before dispatching events.
                  </p>
                </div>

                <button
                  onClick={handleDispatchServerTelemetry}
                  className="w-full rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-semibold py-2.5 text-xs transition"
                >
                  Dispatch Server-Side Braze Adherence Nudge (Test PHI Scrubber)
                </button>

                {telemetryResult && (
                  <div className="rounded-xl bg-slate-950 border border-slate-800 p-4 space-y-2 text-xs font-mono">
                    <div className="flex items-center justify-between">
                      <span className="text-emerald-400 font-bold">
                        HTTP {telemetryResult.httpStatus} ({telemetryResult.status})
                      </span>
                      <span className="text-slate-400">HIPAA Safe: true</span>
                    </div>
                    <p className="text-rose-300">
                      Stripped PHI & Ad Keys:{" "}
                      {telemetryResult.scrubbedResult?.strippedKeys?.join(", ")}
                    </p>
                    <p className="text-sky-300">
                      Forwarded Safe Payload:{" "}
                      {JSON.stringify(telemetryResult.scrubbedResult?.safeAttributes)}
                    </p>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}