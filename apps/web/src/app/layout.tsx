import type { Metadata } from "next";
import "./globals.css";
import { ClinicalPrivacySandbox } from "../components/ClinicalPrivacySandbox";

export const metadata: Metadata = {
  title: "Titrate-Health | GLP-1 Clinical Telemetry & Triage Platform",
  description:
    "Full-stack clinical weight management, GLP-1 titration state machine, and clinician triage portal.",
  manifest: "/site.webmanifest",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
        <ClinicalPrivacySandbox />
        {children}
      </body>
    </html>
  );
}