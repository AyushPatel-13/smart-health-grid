"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { saveFacilityAction, saveUserAction } from "@/app/actions/admin";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormStatus, SubmitButton, inputClass, useActionForm } from "@/components/ui/form";
import { buttonClass } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n/client";
import { ROLES, facilitySchema, userSchema } from "@/lib/validation/schemas";

const optNum = { setValueAs: (v: string) => (v === "" || v === null || v === undefined ? null : Number(v)) };

export interface FacilityValue {
  id: string | null;
  code: string;
  name: string;
  nameHi: string | null;
  facilityType: "PHC" | "CHC";
  districtId: string;
  block: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  bedCapacity: number;
  opdCapacity: number;
  operationalStatus: "operational" | "limited" | "non_operational";
}

export function FacilityFormButton({ value, districts }: { value: FacilityValue | null; districts: { id: string; name: string }[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={buttonClass(value ? "secondary" : "primary", value ? "sm" : "md")} onClick={() => setOpen(true)}>
        {value ? <Pencil className="size-3.5" aria-hidden /> : <Plus className="size-4" aria-hidden />}
        {value ? t("common.edit") : t("admin.addFacility")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={value ? t("admin.editFacility") : t("admin.addFacility")} wide>
        {open && <FacilityForm value={value} districts={districts} onDone={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function FacilityForm({ value, districts, onDone }: { value: FacilityValue | null; districts: { id: string; name: string }[]; onDone: () => void }) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status } = useActionForm(facilitySchema, saveFacilityAction, {
    defaultValues: value ?? {
      id: null,
      code: "",
      name: "",
      nameHi: "",
      facilityType: "PHC",
      districtId: districts[0]?.id ?? "",
      block: "",
      address: "",
      latitude: null,
      longitude: null,
      bedCapacity: 10,
      opdCapacity: 100,
      operationalStatus: "operational",
    },
    onSuccess: () => setTimeout(onDone, 600),
  });
  const e = form.formState.errors;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2" noValidate>
      <Field label={t("common.code")} error={e.code?.message} htmlFor="f-code">
        <input id="f-code" className={inputClass} aria-invalid={!!e.code} {...form.register("code")} />
      </Field>
      <Field label={t("common.type")} htmlFor="f-type">
        <select id="f-type" className={inputClass} {...form.register("facilityType")}>
          <option value="PHC">{t("facilityType.PHCLong")}</option>
          <option value="CHC">{t("facilityType.CHCLong")}</option>
        </select>
      </Field>
      <Field label={t("common.name")} error={e.name?.message} htmlFor="f-name">
        <input id="f-name" className={inputClass} aria-invalid={!!e.name} {...form.register("name")} />
      </Field>
      <Field label={`${t("common.name")} (हिंदी)`} htmlFor="f-namehi">
        <input id="f-namehi" lang="hi" className={inputClass} {...form.register("nameHi")} />
      </Field>
      <Field label={t("common.district")} error={e.districtId?.message} htmlFor="f-dist">
        <select id="f-dist" className={inputClass} {...form.register("districtId")}>
          {districts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t("facility.block")} htmlFor="f-block">
        <input id="f-block" className={inputClass} {...form.register("block")} />
      </Field>
      <Field label={t("facility.capacity")} error={e.bedCapacity?.message} htmlFor="f-beds">
        <input id="f-beds" type="number" min={0} className={inputClass} {...form.register("bedCapacity", { valueAsNumber: true })} />
      </Field>
      <Field label={t("facility.opdCapacity")} error={e.opdCapacity?.message} htmlFor="f-opd">
        <input id="f-opd" type="number" min={1} className={inputClass} {...form.register("opdCapacity", { valueAsNumber: true })} />
      </Field>
      <Field label={t("admin.latitude")} error={e.latitude?.message} htmlFor="f-lat">
        <input id="f-lat" type="number" step="0.0001" className={inputClass} {...form.register("latitude", optNum)} />
      </Field>
      <Field label={t("admin.longitude")} error={e.longitude?.message} htmlFor="f-lon">
        <input id="f-lon" type="number" step="0.0001" className={inputClass} {...form.register("longitude", optNum)} />
      </Field>
      <Field label={t("common.status")} htmlFor="f-status">
        <select id="f-status" className={inputClass} {...form.register("operationalStatus")}>
          {(["operational", "limited", "non_operational"] as const).map((s) => (
            <option key={s} value={s}>
              {t(`opStatus.${s}`)}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <FormStatus status={status} />
        <div>
          <SubmitButton pending={pending}>{t("common.save")}</SubmitButton>
        </div>
      </div>
    </form>
  );
}

export interface UserValue {
  id: string | null;
  email: string;
  fullName: string;
  role: (typeof ROLES)[number];
  facilityId: string | null;
  isActive: boolean;
}

export function UserFormButton({ value, facilities, demoMode }: { value: UserValue | null; facilities: { id: string; name: string }[]; demoMode: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={buttonClass(value ? "secondary" : "primary", value ? "sm" : "md")} onClick={() => setOpen(true)}>
        {value ? <Pencil className="size-3.5" aria-hidden /> : <Plus className="size-4" aria-hidden />}
        {value ? t("common.edit") : t("admin.addUser")}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title={value ? `${t("common.edit")}: ${value.fullName}` : t("admin.addUser")}>
        {open && <UserForm value={value} facilities={facilities} demoMode={demoMode} onDone={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function UserForm({ value, facilities, demoMode, onDone }: { value: UserValue | null; facilities: { id: string; name: string }[]; demoMode: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const { form, onSubmit, pending, status } = useActionForm(userSchema, saveUserAction, {
    defaultValues: value ?? { id: null, email: "", fullName: "", role: "facility_staff", facilityId: "", isActive: true, password: "" },
    onSuccess: () => setTimeout(onDone, 600),
  });
  const e = form.formState.errors;
  const role = form.watch("role");
  return (
    <form onSubmit={onSubmit} className="grid gap-3" noValidate>
      <Field label={t("admin.email")} error={e.email?.message} htmlFor="u-email">
        <input id="u-email" type="email" readOnly={!!value} className={inputClass} aria-invalid={!!e.email} {...form.register("email")} />
      </Field>
      <Field label={t("admin.fullName")} error={e.fullName?.message} htmlFor="u-name">
        <input id="u-name" className={inputClass} aria-invalid={!!e.fullName} {...form.register("fullName")} />
      </Field>
      <Field label={t("admin.role")} error={e.role?.message} htmlFor="u-role">
        <select id="u-role" className={inputClass} {...form.register("role")}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`)}
            </option>
          ))}
        </select>
      </Field>
      {role === "facility_staff" && (
        <Field label={t("admin.assignedFacility")} error={e.facilityId?.message} htmlFor="u-fac">
          <select id="u-fac" className={inputClass} aria-invalid={!!e.facilityId} {...form.register("facilityId")}>
            <option value="">—</option>
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!value && demoMode && (
        <Field label={t("admin.tempPassword")} error={e.password?.message} htmlFor="u-pw">
          <input id="u-pw" type="password" autoComplete="new-password" className={inputClass} {...form.register("password")} />
        </Field>
      )}
      {!value && !demoMode && <p className="text-[12px] text-ink-muted">{t("admin.supabaseUserHint")}</p>}
      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" className="size-4 accent-brand-600" {...form.register("isActive")} />
        {t("admin.active")}
      </label>
      <FormStatus status={status} />
      <div>
        <SubmitButton pending={pending}>{t("admin.saveUser")}</SubmitButton>
      </div>
    </form>
  );
}
