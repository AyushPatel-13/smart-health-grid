"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import {
  addShiftAction,
  recordAttendanceAction,
  saveBedStatusAction,
  savePatientStatsAction,
  updateDiagnosticAction,
  verifyAttendanceAction,
} from "@/app/actions/operations";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormStatus, SubmitButton, inputClass, textareaClass, useActionForm, useActionRunner } from "@/components/ui/form";
import { Notice, buttonClass, cn } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";
import {
  DIAG_STATUS,
  SHIFT_TYPES,
  addShiftSchema,
  bedSchema,
  diagnosticSchema,
  patientStatsSchema,
} from "@/lib/validation/schemas";

const num = { valueAsNumber: true } as const;

// ---------------------------------------------------------------------------
// Patient footfall
// ---------------------------------------------------------------------------
export function FootfallForm({ facilityId, today, existingDates }: { facilityId: string; today: string; existingDates: string[] }) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status } = useActionForm(patientStatsSchema, savePatientStatsAction, {
    defaultValues: { facilityId, statDate: today, isCorrection: false, ipdAdmissions: 0, emergencyVisits: 0, notes: "", correctionReason: "" },
  });
  const e = form.formState.errors;
  const date = form.watch("statDate");
  const isCorrection = form.watch("isCorrection");
  const exists = existingDates.includes(date);
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" noValidate>
      <Field label={t("footfall.statDate")} error={e.statDate?.message} htmlFor="ff-date">
        <input id="ff-date" type="date" max={today} className={inputClass} aria-invalid={!!e.statDate} {...form.register("statDate")} />
      </Field>
      <Field label={t("footfall.opd")} error={e.opdVisits?.message} htmlFor="ff-opd">
        <input id="ff-opd" type="number" min={0} inputMode="numeric" className={inputClass} aria-invalid={!!e.opdVisits} {...form.register("opdVisits", num)} />
      </Field>
      <Field label={t("footfall.ipd")} error={e.ipdAdmissions?.message} htmlFor="ff-ipd">
        <input id="ff-ipd" type="number" min={0} inputMode="numeric" className={inputClass} {...form.register("ipdAdmissions", num)} />
      </Field>
      <Field label={t("footfall.emergency")} error={e.emergencyVisits?.message} htmlFor="ff-em">
        <input id="ff-em" type="number" min={0} inputMode="numeric" className={inputClass} {...form.register("emergencyVisits", num)} />
      </Field>
      {exists && !isCorrection && (
        <Notice tone="warning" className="sm:col-span-2 lg:col-span-4">
          {t("footfall.duplicate")}
        </Notice>
      )}
      <label className="flex items-center gap-2 text-[13px] sm:col-span-2 lg:col-span-4">
        <input type="checkbox" className="size-4 accent-brand-600" {...form.register("isCorrection")} />
        {t("footfall.correction")}
      </label>
      {isCorrection && (
        <Field label={t("footfall.correctionReason")} error={e.correctionReason?.message} className="sm:col-span-2 lg:col-span-4" htmlFor="ff-reason">
          <textarea id="ff-reason" className={textareaClass} aria-invalid={!!e.correctionReason} {...form.register("correctionReason")} />
        </Field>
      )}
      <div className="flex flex-col gap-2 sm:col-span-2 lg:col-span-4">
        <FormStatus status={status} />
        <div>
          <SubmitButton pending={pending}>{t("footfall.record")}</SubmitButton>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Beds
// ---------------------------------------------------------------------------
export interface WardValue {
  id: string | null;
  ward: string;
  total_beds: number;
  occupied_beds: number;
  out_of_service_beds: number;
}

export function BedWardButton({ facilityId, ward }: { facilityId: string; ward: WardValue | null }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={buttonClass(ward ? "secondary" : "primary", "sm")} onClick={() => setOpen(true)}>
        {ward ? <Pencil className="size-3.5" aria-hidden /> : <Plus className="size-3.5" aria-hidden />}
        {ward ? t("beds.update") : t("beds.addWard")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={ward ? `${t("beds.update")}: ${ward.ward}` : t("beds.addWard")}>
        {open && <BedForm facilityId={facilityId} ward={ward} onDone={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function BedForm({ facilityId, ward, onDone }: { facilityId: string; ward: WardValue | null; onDone: () => void }) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status } = useActionForm(bedSchema, saveBedStatusAction, {
    defaultValues: {
      facilityId,
      wardId: ward?.id ?? null,
      ward: ward?.ward ?? "",
      totalBeds: ward?.total_beds ?? 0,
      occupiedBeds: ward?.occupied_beds ?? 0,
      outOfServiceBeds: ward?.out_of_service_beds ?? 0,
    },
    onSuccess: () => setTimeout(onDone, 600),
  });
  const e = form.formState.errors;
  const [total, occ, oos] = form.watch(["totalBeds", "occupiedBeds", "outOfServiceBeds"]);
  const available = (Number(total) || 0) - (Number(occ) || 0) - (Number(oos) || 0);
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label={t("beds.wardName")} error={e.ward?.message} className="sm:col-span-2" htmlFor="bed-ward">
        <input id="bed-ward" className={inputClass} aria-invalid={!!e.ward} {...form.register("ward")} />
      </Field>
      <Field label={t("beds.total")} error={e.totalBeds?.message} htmlFor="bed-total">
        <input id="bed-total" type="number" min={0} inputMode="numeric" className={inputClass} {...form.register("totalBeds", num)} />
      </Field>
      <Field label={t("beds.occupied")} error={e.occupiedBeds?.message} htmlFor="bed-occ">
        <input id="bed-occ" type="number" min={0} inputMode="numeric" className={inputClass} aria-invalid={!!e.occupiedBeds} {...form.register("occupiedBeds", num)} />
      </Field>
      <Field label={t("beds.outOfService")} error={e.outOfServiceBeds?.message} htmlFor="bed-oos">
        <input id="bed-oos" type="number" min={0} inputMode="numeric" className={inputClass} {...form.register("outOfServiceBeds", num)} />
      </Field>
      <div className="flex flex-col justify-end">
        <p className="text-[13px] text-ink-muted">{t("beds.available")}</p>
        <p className={cn("tabular text-xl font-semibold", available < 0 ? "text-red-700" : "text-ink")}>{available}</p>
      </div>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <p className="text-xs text-ink-muted">{t("beds.subtitle")}</p>
        <FormStatus status={status} />
        <div>
          <SubmitButton pending={pending}>{t("common.save")}</SubmitButton>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------
export function AttendanceActions({
  shiftId,
  attendanceId,
  status,
  verified,
  canRecord,
  canVerify,
  isFuture,
}: {
  shiftId: string;
  attendanceId: string | null;
  status: string | null;
  verified: boolean;
  canRecord: boolean;
  canVerify: boolean;
  isFuture: boolean;
}) {
  const { t } = useI18n();
  const { run, pending, status: res } = useActionRunner();
  const locked = verified && !canVerify;
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-1">
        {canRecord && !isFuture && !locked && (
          <>
            {(["present", "absent", "approved_leave"] as const).map((s) => (
              <button
                key={s}
                type="button"
                disabled={pending || status === s}
                onClick={() => run(() => recordAttendanceAction({ shiftId, status: s }))}
                className={cn(buttonClass(status === s ? "primary" : "secondary", "sm"), "h-7 px-2 text-xs")}
              >
                {s === "present" ? t("attendance.markPresent") : s === "absent" ? t("attendance.markAbsent") : t("attendance.markLeave")}
              </button>
            ))}
          </>
        )}
        {canVerify && attendanceId && !verified && (
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => verifyAttendanceAction({ attendanceId }))}
            className={cn(buttonClass("teal", "sm"), "h-7 px-2 text-xs")}
          >
            {t("attendance.verify")}
          </button>
        )}
      </div>
      {res?.tone === "critical" && <p className="text-[11px] text-red-700">{res.text}</p>}
    </div>
  );
}

export function AddShiftForm({ staff, defaultDate }: { staff: { id: string; label: string }[]; defaultDate: string }) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status } = useActionForm(addShiftSchema, addShiftAction, {
    defaultValues: { staffId: "", shiftDate: defaultDate, shiftType: "morning" },
  });
  const e = form.formState.errors;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end" noValidate>
      <Field label={t("attendance.staffMember")} error={e.staffId?.message} htmlFor="sh-staff">
        <select id="sh-staff" className={inputClass} aria-invalid={!!e.staffId} {...form.register("staffId")}>
          <option value="">—</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("common.date")} error={e.shiftDate?.message} htmlFor="sh-date">
        <input id="sh-date" type="date" className={inputClass} {...form.register("shiftDate")} />
      </Field>
      <Field label={t("attendance.shift")} error={e.shiftType?.message} htmlFor="sh-type">
        <select id="sh-type" className={inputClass} {...form.register("shiftType")}>
          {SHIFT_TYPES.map((s) => (
            <option key={s} value={s}>
              {t(`shiftType.${s}`)}
            </option>
          ))}
        </select>
      </Field>
      <SubmitButton pending={pending}>{t("attendance.addShift")}</SubmitButton>
      <div className="sm:col-span-4">
        <FormStatus status={status} />
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
export interface DiagnosticValue {
  id: string;
  name: string;
  status: (typeof DIAG_STATUS)[number];
  restriction_note: string | null;
  unavailability_reason: string | null;
  equipment_issue: string | null;
  required_supplies: string | null;
  estimated_restoration_date: string | null;
}

export function DiagnosticEditButton({ service }: { service: DiagnosticValue }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setOpen(true)}>
        <Pencil className="size-3.5" aria-hidden />
        {t("diagnostics.update")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`${t("diagnostics.update")}: ${service.name}`}>
        {open && <DiagnosticForm service={service} onDone={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function DiagnosticForm({ service, onDone }: { service: DiagnosticValue; onDone: () => void }) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status } = useActionForm(diagnosticSchema, updateDiagnosticAction, {
    defaultValues: {
      serviceId: service.id,
      status: service.status,
      restrictionNote: service.restriction_note ?? "",
      unavailabilityReason: service.unavailability_reason ?? "",
      equipmentIssue: service.equipment_issue ?? "",
      requiredSupplies: service.required_supplies ?? "",
      estimatedRestorationDate: service.estimated_restoration_date ?? "",
    },
    onSuccess: () => setTimeout(onDone, 600),
  });
  const e = form.formState.errors;
  const st = form.watch("status");
  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      <Field label={t("common.status")} htmlFor="dx-status">
        <select id="dx-status" className={inputClass} {...form.register("status")}>
          {DIAG_STATUS.map((s) => (
            <option key={s} value={s}>
              {t(`diagStatus.${s}`)}
            </option>
          ))}
        </select>
      </Field>
      {st !== "available" && (
        <>
          {st === "limited" && (
            <Field label={t("diagnostics.restriction")} error={e.restrictionNote?.message} htmlFor="dx-restr">
              <input id="dx-restr" className={inputClass} {...form.register("restrictionNote")} />
            </Field>
          )}
          <Field label={t("diagnostics.reasonUnavailable")} error={e.unavailabilityReason?.message} htmlFor="dx-reason">
            <input id="dx-reason" className={inputClass} aria-invalid={!!e.unavailabilityReason} {...form.register("unavailabilityReason")} />
          </Field>
          <Field label={`${t("diagnostics.equipmentIssue")} (${t("common.optional")})`} htmlFor="dx-eq">
            <input id="dx-eq" className={inputClass} {...form.register("equipmentIssue")} />
          </Field>
          <Field label={`${t("diagnostics.requiredSupplies")} (${t("common.optional")})`} htmlFor="dx-sup">
            <input id="dx-sup" className={inputClass} {...form.register("requiredSupplies")} />
          </Field>
          <Field label={`${t("diagnostics.restoration")} (${t("common.optional")})`} error={e.estimatedRestorationDate?.message} htmlFor="dx-date">
            <input id="dx-date" type="date" className={inputClass} {...form.register("estimatedRestorationDate")} />
          </Field>
        </>
      )}
      <FormStatus status={status} />
      <div>
        <SubmitButton pending={pending}>{t("common.save")}</SubmitButton>
      </div>
    </form>
  );
}
