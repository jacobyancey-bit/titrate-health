import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Titrate-Health | GLP-1 Clinical Telemetry & Triage Platform",
  description:
    "Full-stack clinical weight management, GLP-1 titration state machine, and clinician triage portal.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
        {children}
      </body>
    </html>
  );
}