"use client";

/**
 * @fileoverview Main Interactive Clinical Telemetry & Clinician Triage Portal.
 *
 * Architectural Highlights:
 * 1. Shares domain constants & `calculateBmi()` directly from `@titrate-health/shared`.
 * 2. Authenticates against `POST /api/auth/demo-token` with live RBAC role switching (`PATIENT` vs `CLINICIAN`).
 * 3. Visualizes the Redis Cache-Aside state (`REDIS_HIT` vs `POSTGRES_MISS`) in real time.
 * 4. Renders the FDA Semaglutide titration ladder (`0.25 -> 0.5 -> 1.0 -> 1.7 -> 2.4 mg`),
 *    biometric trend telemetry, intake submission, and clinician review queue.
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
} from "lucide-react";

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type Role = "PATIENT" | "CLINICIAN";

export default function TitrateHealthPortal() {
  const [role, setRole] = useState<Role>("PATIENT");
  const [token, setToken] = useState<string>("");
  const [userEmail, setUserEmail] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [statusBanner, setStatusBanner] = useState<string>("");

  // Patient Dashboard State
  const [cacheSource, setCacheSource] = useState<"REDIS_HIT" | "POSTGRES_MISS" | null>(null);
  const [dashboard, setDashboard] = useState<any>(null);

  // Patient Forms State
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

  // Clinician Queue State
  const [intakeQueue, setIntakeQueue] = useState<any[]>([]);

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
      } else {
        await fetchClinicianQueue(data.token);
      }
    } catch (err: any) {
      setStatusBanner(`Error: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * 2. Fetch Patient Dashboard (demonstrates Redis Cache-Aside: REDIS_HIT vs POSTGRES_MISS).
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
   * 3. Fetch Clinician Intake Triage Queue.
   */
  const fetchClinicianQueue = async (jwtToken = token) => {
    const res = await fetch(`${API_BASE}/api/intake/queue`, {
      headers: { Authorization: `Bearer ${jwtToken}` },
    });
    const payload = await res.json();
    if (res.ok) {
      setIntakeQueue(payload.intakes || []);
    }
  };

  useEffect(() => {
    authenticateRole("PATIENT");
  }, [authenticateRole]);

  /**
   * Submit Daily Biometrics (Evicts Redis cache & refreshes dashboard).
   */
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

  /**
   * Submit Weekly GLP-1 Dose (Evicts Redis cache & re-evaluates Titration State Machine).
   */
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

  /**
   * Submit New Clinical Intake (Runs Zod validation + FDA BMI & Contraindication Triage).
   */
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

  /**
   * Clinician Approves or Rejects an Intake in ACID transaction.
   */
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
                  GLP-1 Telemetry & RBAC
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Signed in as <span className="text-slate-200 font-mono">{userEmail || "..."}</span>
              </p>
            </div>
          </div>

          {/* RBAC Role Switcher + Cache Status */}
          <div className="flex items-center gap-3">
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
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                  role === "PATIENT"
                    ? "bg-emerald-500 text-slate-950 shadow"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <UserCheck className="h-3.5 w-3.5" />
                Patient View
              </button>
              <button
                onClick={() => authenticateRole("CLINICIAN")}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition ${
                  role === "CLINICIAN"
                    ? "bg-indigo-500 text-white shadow"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                <Stethoscope className="h-3.5 w-3.5" />
                Clinician Triage (RBAC)
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
            {/* 1. KPI Summary Row */}
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="rounded-2xl bg-slate-900/90 border border-slate-800 p-5">
                <p className="text-xs uppercase tracking-wider text-slate-400">
                  Current Weight
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
                  Tracked across {dashboard.biometrics.length} biometric check-ins
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

            {/* 3. Interactive Telemetry Forms (Biometrics, Dose Log, Intake) */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Form A: Log Weight & Nutrition */}
              <form
                onSubmit={handleLogBiometrics}
                className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-4"
              >
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  <Scale className="h-4 w-4 text-sky-400" />
                  1. Log Biometric Check-In
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

              {/* Form B: Log Weekly GLP-1 Dose */}
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

              {/* Form C: Submit Clinical Intake Triage */}
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
        ) : (
          /* CLINICIAN RBAC TRIAGE VIEW */
          <section className="rounded-2xl bg-slate-900/90 border border-slate-800 p-6 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Stethoscope className="h-4 w-4 text-indigo-400" />
                  Clinician Intake Triage Queue (RBAC Protected: CLINICIAN Role Only)
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Approving an intake executes a Prisma ACID transaction that updates intake
                  status, seeds Week 1 Semaglutide (0.25mg), and writes a HIPAA AuditLog.
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
                        {item.patientProfile?.user?.email || "Patient"}
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
        )}
      </main>
    </div>
  );
}