-- CreateEnum
CREATE TYPE "IntakeStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'INELIGIBLE');

-- CreateTable
CREATE TABLE "PatientProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "heightInches" DOUBLE PRECISION NOT NULL,
    "startingWeightLb" DOUBLE PRECISION NOT NULL,
    "goalWeightLb" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PatientProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClinicalIntake" (
    "id" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "calculatedBmi" DOUBLE PRECISION NOT NULL,
    "comorbidities" TEXT[],
    "contraindications" TEXT[],
    "status" "IntakeStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewedByClinician" TEXT,
    "clinicianNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClinicalIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedicationLog" (
    "id" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "medicationName" TEXT NOT NULL,
    "dosageMg" DOUBLE PRECISION NOT NULL,
    "weekNumber" INTEGER NOT NULL,
    "sideEffects" TEXT[],
    "administeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedicationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BiometricEntry" (
    "id" TEXT NOT NULL,
    "patientProfileId" TEXT NOT NULL,
    "weightLb" DOUBLE PRECISION NOT NULL,
    "proteinGrams" INTEGER,
    "waterOunces" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BiometricEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetResourceId" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PatientProfile_userId_key" ON "PatientProfile"("userId");

-- CreateIndex
CREATE INDEX "ClinicalIntake_patientProfileId_status_idx" ON "ClinicalIntake"("patientProfileId", "status");

-- CreateIndex
CREATE INDEX "MedicationLog_patientProfileId_administeredAt_idx" ON "MedicationLog"("patientProfileId", "administeredAt");

-- CreateIndex
CREATE INDEX "BiometricEntry_patientProfileId_recordedAt_idx" ON "BiometricEntry"("patientProfileId", "recordedAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_idx" ON "AuditLog"("actorId");

-- CreateIndex
CREATE INDEX "AuditLog_targetResourceId_idx" ON "AuditLog"("targetResourceId");

-- AddForeignKey
ALTER TABLE "PatientProfile" ADD CONSTRAINT "PatientProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClinicalIntake" ADD CONSTRAINT "ClinicalIntake_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedicationLog" ADD CONSTRAINT "MedicationLog_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BiometricEntry" ADD CONSTRAINT "BiometricEntry_patientProfileId_fkey" FOREIGN KEY ("patientProfileId") REFERENCES "PatientProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
