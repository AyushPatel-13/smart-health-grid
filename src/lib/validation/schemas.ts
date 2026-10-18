import { z } from "zod";
import { isValidDay } from "../dates";

// Shared Zod schemas: used by React Hook Form on the client for instant
// feedback and re-validated by every server action. Messages are i18n keys.

const id = z.guid({ error: "validation.invalid" });
const optionalId = z.union([id, z.literal(""), z.undefined(), z.null()]).transform((v) => (v ? v : null));
const day = z.string({ error: "validation.invalidDate" }).refine(isValidDay, "validation.invalidDate");
const int = (msg: string) => z.number({ error: msg }).int(msg).max(1_000_000, "validation.maxValue");
const posInt = int("validation.positiveInt").positive("validation.positiveInt");
const nonNegInt = int("validation.nonNegativeInt").min(0, "validation.nonNegativeInt");
const reason = z.string({ error: "validation.reasonMin" }).trim().min(5, "validation.reasonMin").max(300, "validation.tooLong");
const optText = (max = 300) =>
  z
    .string()
    .trim()
    .max(max, "validation.tooLong")
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));
const idem = z.string().min(8).max(80);

export const BATCH_SOURCES = ["state_supply", "district_warehouse", "local_purchase", "transfer", "donation", "other"] as const;

export const addBatchSchema = z.object({
  facilityId: id,
  medicineId: id,
  batchNumber: z.string().trim().regex(/^[A-Za-z0-9/_-]{2,40}$/, "validation.batchFormat"),
  quantity: posInt,
  expiryDate: day,
  supplier: optText(120),
  source: z.enum(BATCH_SOURCES),
  idempotencyKey: idem,
});

export const receiptSchema = z.object({
  batchId: id,
  quantity: posInt,
  reason: optText(),
  idempotencyKey: idem,
});

export const issueSchema = z.object({
  facilityId: id,
  medicineId: id,
  quantity: posInt,
  reason: optText(),
  idempotencyKey: idem,
});

export const adjustmentSchema = z.object({
  batchId: id,
  quantity: int("validation.nonZeroInt").min(-1_000_000, "validation.maxValue").refine((n) => n !== 0, "validation.nonZeroInt"),
  reason,
  idempotencyKey: idem,
});

export const writeOffSchema = z.object({
  batchId: id,
  quantity: posInt,
  reason: optText(),
  idempotencyKey: idem,
});

export const patientStatsSchema = z
  .object({
    facilityId: id,
    statDate: day,
    opdVisits: nonNegInt.max(20000, "validation.maxValue"),
    ipdAdmissions: nonNegInt.max(2000, "validation.maxValue"),
    emergencyVisits: nonNegInt.max(5000, "validation.maxValue"),
    notes: optText(),
    isCorrection: z.boolean(),
    correctionReason: optText(),
  })
  .refine((v) => !v.isCorrection || (v.correctionReason?.length ?? 0) >= 5, {
    path: ["correctionReason"],
    message: "validation.reasonMin",
  });

export const bedSchema = z
  .object({
    facilityId: id,
    wardId: optionalId,
    ward: z.string().trim().min(2, "validation.required").max(60, "validation.tooLong"),
    totalBeds: nonNegInt.max(1000, "validation.maxValue"),
    occupiedBeds: nonNegInt,
    outOfServiceBeds: nonNegInt,
  })
  .refine((v) => v.occupiedBeds + v.outOfServiceBeds <= v.totalBeds, {
    path: ["occupiedBeds"],
    message: "beds.exceeds",
  });

export const ATTENDANCE_STATUS = ["present", "absent", "approved_leave"] as const;
export const attendanceSchema = z.object({
  shiftId: id,
  status: z.enum(ATTENDANCE_STATUS),
  notes: optText(),
});

export const verifyAttendanceSchema = z.object({ attendanceId: id });

export const SHIFT_TYPES = ["morning", "evening", "night", "on_call"] as const;
export const addShiftSchema = z.object({
  staffId: id,
  shiftDate: day,
  shiftType: z.enum(SHIFT_TYPES),
});

export const DIAG_STATUS = ["available", "limited", "unavailable"] as const;
export const diagnosticSchema = z
  .object({
    serviceId: id,
    status: z.enum(DIAG_STATUS),
    restrictionNote: optText(),
    unavailabilityReason: optText(),
    equipmentIssue: optText(),
    requiredSupplies: optText(),
    estimatedRestorationDate: z
      .union([day, z.literal(""), z.null(), z.undefined()])
      .transform((v) => (v ? v : null)),
  })
  .refine((v) => v.status === "available" || (v.unavailabilityReason ?? v.restrictionNote ?? "").length >= 3, {
    path: ["unavailabilityReason"],
    message: "diagnostics.reasonRequired",
  });

export const ALERT_ACTIONS = ["assign", "acknowledge", "resolve", "reopen"] as const;
export const alertActionSchema = z
  .object({
    alertId: id,
    action: z.enum(ALERT_ACTIONS),
    assigneeId: optionalId,
    notes: optText(1000),
  })
  .refine((v) => !(v.action === "resolve" || v.action === "reopen") || (v.notes?.length ?? 0) >= 5, {
    path: ["notes"],
    message: "alerts.notesRequired",
  })
  .refine((v) => v.action !== "assign" || !!v.assigneeId, { path: ["assigneeId"], message: "validation.required" });

export const manualAlertSchema = z.object({
  facilityId: id,
  severity: z.enum(["critical", "warning", "info"]),
  title: z.string().trim().min(5, "validation.reasonMin").max(140, "validation.tooLong"),
  explanation: z.string().trim().min(5, "validation.reasonMin").max(1000, "validation.tooLong"),
  recommendedAction: optText(500),
});

export const transferRequestSchema = z.object({
  medicineId: id,
  toFacilityId: id,
  fromFacilityId: optionalId,
  quantity: posInt,
  justification: reason,
  recommendationKey: z.string().max(200).optional().nullable(),
  source: z.enum(["redistribution", "expiry"]).optional().nullable(),
});

export const reviewTransferSchema = z
  .object({
    transferId: id,
    decision: z.enum(["approve", "reject"]),
    fromFacilityId: optionalId,
    quantity: posInt.optional().nullable(),
    notes: optText(500),
  })
  .refine((v) => v.decision === "approve" || (v.notes?.length ?? 0) >= 5, { path: ["notes"], message: "transfers.rejectNotesRequired" });

export const facilitySchema = z.object({
  id: optionalId,
  code: z.string().trim().regex(/^[A-Z0-9-]{3,32}$/, "validation.codeFormat"),
  name: z.string().trim().min(3, "validation.required").max(120, "validation.tooLong"),
  nameHi: optText(120),
  facilityType: z.enum(["PHC", "CHC"]),
  districtId: id,
  block: optText(80),
  address: optText(200),
  latitude: z.number().min(-90, "validation.invalid").max(90, "validation.invalid").optional().nullable(),
  longitude: z.number().min(-180, "validation.invalid").max(180, "validation.invalid").optional().nullable(),
  bedCapacity: nonNegInt.max(1000, "validation.maxValue"),
  opdCapacity: posInt.max(5000, "validation.maxValue"),
  operationalStatus: z.enum(["operational", "limited", "non_operational"]),
});

export const ROLES = ["district_admin", "facility_staff", "read_only"] as const;
export const userSchema = z
  .object({
    id: optionalId,
    email: z.email({ error: "validation.invalidEmail" }).max(160),
    fullName: z.string().trim().min(2, "validation.required").max(120, "validation.tooLong"),
    role: z.enum(ROLES),
    facilityId: optionalId,
    password: z.string().max(72).optional().nullable(),
    isActive: z.boolean(),
  })
  .refine((v) => v.role !== "facility_staff" || !!v.facilityId, { path: ["facilityId"], message: "validation.facilityRequired" })
  .refine((v) => !!v.id || !v.password || v.password.length >= 8, { path: ["password"], message: "validation.passwordMin" });

export type AddBatchInput = z.infer<typeof addBatchSchema>;
