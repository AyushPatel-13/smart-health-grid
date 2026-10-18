"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { AlertOctagon, CheckCircle2, Crosshair, MapPin } from "lucide-react";
import { recommendAction, registerAction } from "@/app/actions/patients";
import { Field, inputClass } from "@/components/ui/form";
import { Badge, Card, CardBody, CardHeader, Notice, buttonClass, cn } from "@/components/ui/primitives";
import type { FacilityRecommendation } from "@/lib/allocation/recommend";
import { formatDateTime, formatDay, localName } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/client";

interface Props {
  services: { id: string; name: string; emergency: boolean; category: string }[];
  dates: string[];
  times: Record<string, Record<string, string[]>>;
  localities: { name: string; value: string; lat: number; lon: number }[];
  cutoffIso: string;
}

type Result = { patientCode: string; pin: string; status: string; cutoff: string | null; emergency: { name: string; km: number } | null };

export function RegisterForm({ services, dates, times, localities, cutoffIso }: Props) {
  const { t, tx, locale } = useI18n();
  const [serviceId, setServiceId] = useState("");
  const [date, setDate] = useState(dates[0]);
  const [time, setTime] = useState("");
  const [locality, setLocality] = useState("");
  const [device, setDevice] = useState<{ lat: number; lon: number } | null>(null);
  const [geoMsg, setGeoMsg] = useState<string | null>(null);
  const [recs, setRecs] = useState<FacilityRecommendation[] | null>(null);
  const [preferred, setPreferred] = useState<string>("");
  const [details, setDetails] = useState({ fullName: "", birthYear: "", sex: "undisclosed", phone: "", language: locale, consentData: false, consentLocation: false, consentSms: false });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [pending, start] = useTransition();
  const [key] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`));

  const service = services.find((s) => s.id === serviceId);
  const timeOptions = useMemo(() => (serviceId ? times[serviceId]?.[date] ?? [] : []), [serviceId, date, times]);
  const loc = device ?? (locality ? localities.find((l) => l.value === locality) ?? null : null);
  const emergency = !!service?.emergency;
  const step1Ready = !!serviceId && !!loc && (emergency || !!time);

  const useDevice = () => {
    if (!("geolocation" in navigator)) return setGeoMsg(t("patient.deviceFailed"));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Round to ~110 m before it leaves the device.
        setDevice({ lat: Math.round(pos.coords.latitude * 1000) / 1000, lon: Math.round(pos.coords.longitude * 1000) / 1000 });
        setLocality("");
        setGeoMsg(t("patient.deviceUsed"));
      },
      () => setGeoMsg(t("patient.deviceFailed")),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  };

  const loadRecs = () =>
    start(async () => {
      if (!loc || !serviceId) return;
      const res = await recommendAction({ lat: loc.lat, lon: loc.lon, serviceId, date: emergency ? dates[0] : date, time: emergency ? "09:00" : time });
      setRecs(res.ok ? res.data : []);
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setFormError(null);
    if (!details.consentData || !details.consentLocation) {
      setFormError("patient.consentRequired");
      return;
    }
    start(async () => {
      const res = await registerAction({
        fullName: details.fullName,
        birthYear: details.birthYear ? Number(details.birthYear) : null,
        sex: details.sex,
        phone: details.phone || null,
        addressText: locality || null,
        lat: loc!.lat,
        lon: loc!.lon,
        locationSource: device ? "device" : "locality",
        preferredLanguage: details.language,
        consentData: details.consentData,
        consentLocation: details.consentLocation,
        consentSms: details.consentSms,
        serviceId,
        date: emergency ? dates[0] : date,
        time: emergency ? "00:00" : time,
        preferredFacilityId: preferred || null,
        idempotencyKey: key,
      });
      if (res.ok && res.data) setResult(res.data);
      else if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        setFormError(res.error === "VALIDATION" ? "errors.VALIDATION" : res.error.includes(".") ? res.error : `errors.${res.error}`);
      }
    });
  };

  if (result) {
    return (
      <Card>
        <CardBody className="space-y-4">
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="size-6" aria-hidden />
            <h2 className="text-lg font-semibold">{t("patient.successTitle")}</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-line p-3">
              <p className="text-[12px] text-ink-muted">{t("patient.patientId")}</p>
              <p className="font-mono text-xl font-semibold tracking-wider">{result.patientCode}</p>
            </div>
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-[12px] text-amber-800">{t("patient.pin")}</p>
              <p className="font-mono text-xl font-semibold tracking-widest">{result.pin}</p>
            </div>
          </div>
          <Notice tone="warning">{t("patient.pinWarning")}</Notice>
          {result.emergency || result.status === "emergency_referred" ? (
            <Notice tone="critical">
              <p className="font-semibold">{t("patient.emergencyTitle")}</p>
              <p>{t("patient.emergencyBody")}</p>
              {result.emergency && <p className="mt-1">{t("patient.emergencyNearest", { facility: result.emergency.name, km: result.emergency.km })}</p>}
            </Notice>
          ) : (
            <Notice tone="info">
              <Badge tone="warning">{t("patient.statusPending")}</Badge>{" "}
              {t("patient.pendingInfo", { time: formatDateTime(result.cutoff ?? cutoffIso, locale) })}
            </Notice>
          )}
          <Link href="/patient" className={buttonClass("primary")}>
            {t("patient.checkStatus")}
          </Link>
        </CardBody>
      </Card>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Card>
        <CardHeader title={`1. ${t("patient.step1")}`} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Field label={t("patient.service")} hint={t("patient.serviceHint")} htmlFor="r-service" className="sm:col-span-2">
            <select id="r-service" className={inputClass} value={serviceId} onChange={(e) => { setServiceId(e.target.value); setTime(""); setRecs(null); }}>
              <option value="">—</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.emergency ? " ⚠" : ""}
                </option>
              ))}
            </select>
          </Field>
          {emergency && (
            <Notice tone="critical" className="sm:col-span-2">
              <span className="flex items-center gap-2 font-semibold">
                <AlertOctagon className="size-4" aria-hidden />
                {t("patient.emergencyTitle")}
              </span>
              {t("patient.emergencyBody")}
            </Notice>
          )}
          {!emergency && (
            <>
              <Field label={t("patient.date")} htmlFor="r-date">
                <select id="r-date" className={inputClass} value={date} onChange={(e) => { setDate(e.target.value); setTime(""); setRecs(null); }}>
                  {dates.map((d) => (
                    <option key={d} value={d}>
                      {formatDay(d, locale)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("patient.time")} htmlFor="r-time">
                <select id="r-time" className={inputClass} value={time} onChange={(e) => { setTime(e.target.value); setRecs(null); }} disabled={!serviceId}>
                  <option value="">—</option>
                  {timeOptions.map((tm) => (
                    <option key={tm} value={tm}>
                      {tm}
                    </option>
                  ))}
                </select>
              </Field>
              {serviceId && timeOptions.length === 0 && <p className="text-[13px] text-amber-800 sm:col-span-2">{t("patient.noTimes")}</p>}
            </>
          )}
          <Field label={t("patient.locality")} htmlFor="r-loc">
            <select id="r-loc" className={inputClass} value={locality} onChange={(e) => { setLocality(e.target.value); setDevice(null); setRecs(null); }}>
              <option value="">{t("patient.selectLocality")}</option>
              {localities.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex flex-col justify-end gap-1">
            <button type="button" onClick={useDevice} className={buttonClass("secondary")}>
              <Crosshair className="size-4" aria-hidden />
              {t("patient.useDevice")}
            </button>
            {geoMsg && <p className="text-[12px] text-ink-muted">{geoMsg}</p>}
          </div>
          <div className="sm:col-span-2">
            <button type="button" disabled={!step1Ready || pending} onClick={loadRecs} className={buttonClass("teal")}>
              <MapPin className="size-4" aria-hidden />
              {t("patient.showCentres")}
            </button>
          </div>
        </CardBody>
      </Card>

      {recs && (
        <Card>
          <CardHeader title={t("patient.recommended")} subtitle={`${t("patient.recommendedHint")} ${t("patient.distanceMethod")}.`} />
          <ul className="divide-y divide-line">
            {!emergency && (
              <li className="px-4 py-2.5 sm:px-5">
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="radio" name="pref" checked={preferred === ""} onChange={() => setPreferred("")} className="accent-brand-600" />
                  {t("patient.noPreference")}
                </label>
              </li>
            )}
            {recs.map((r) => (
              <li key={r.facilityId} className={cn("px-4 py-3 sm:px-5", !r.eligible && "bg-slate-50/70")}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <label className="flex items-start gap-2">
                    {!emergency && (
                      <input
                        type="radio"
                        name="pref"
                        disabled={!r.eligible}
                        checked={preferred === r.facilityId}
                        onChange={() => setPreferred(r.facilityId)}
                        className="mt-1 accent-brand-600"
                        aria-label={t("patient.prefer")}
                      />
                    )}
                    <span>
                      <span className="text-[14px] font-medium">
                        {r.facilityId === recs.find((x) => x.eligible)?.facilityId ? "★ " : ""}
                        {localName(r, locale)}
                      </span>
                      <span className="block text-[12px] text-ink-muted">
                        {r.code} · {r.distanceKm} km
                        {r.seatsLeft !== null && ` · ${t("patient.seatsLeft", { n: r.seatsLeft })}`}
                        {` · ${t("patient.queueToday", { n: r.waitingToday })}`}
                        {r.workloadPct !== null && ` · ${t("patient.workload", { pct: r.workloadPct })}`}
                      </span>
                    </span>
                  </label>
                  <Badge tone={r.eligible ? "success" : "neutral"}>{r.eligible ? t("patient.eligible") : t("patient.notEligible")}</Badge>
                </div>
                {(r.reasons.length > 0 || r.notes.length > 0) && (
                  <ul className="mt-1 pl-6 text-[12px]">
                    {r.reasons.map((x, k) => (
                      <li key={`r${k}`} className="text-red-700">• {tx(x.key, x.params)}</li>
                    ))}
                    {r.notes.map((x, k) => (
                      <li key={`n${k}`} className="text-amber-800">• {tx(x.key, x.params)}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {recs && (
        <Card>
          <CardHeader title={`2. ${t("patient.step2")}`} />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            <Field label={t("patient.name")} error={errors.fullName} htmlFor="r-name">
              <input id="r-name" className={inputClass} autoComplete="name" value={details.fullName} onChange={(e) => setDetails({ ...details, fullName: e.target.value })} aria-invalid={!!errors.fullName} />
            </Field>
            <Field label={`${t("patient.birthYear")} (${t("common.optional")})`} error={errors.birthYear} htmlFor="r-by">
              <input id="r-by" type="number" inputMode="numeric" min={1900} className={inputClass} value={details.birthYear} onChange={(e) => setDetails({ ...details, birthYear: e.target.value })} />
            </Field>
            <Field label={t("patient.sex")} htmlFor="r-sex">
              <select id="r-sex" className={inputClass} value={details.sex} onChange={(e) => setDetails({ ...details, sex: e.target.value })}>
                {(["female", "male", "other", "undisclosed"] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`patient.sexOptions.${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`${t("patient.phone")} (${t("common.optional")})`} hint={t("patient.phoneHint")} error={errors.phone} htmlFor="r-phone">
              <input id="r-phone" type="tel" inputMode="numeric" autoComplete="tel" className={inputClass} value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} />
            </Field>
            <Field label={t("patient.language")} htmlFor="r-lang">
              <select id="r-lang" className={inputClass} value={details.language} onChange={(e) => setDetails({ ...details, language: e.target.value as "en" | "hi" })}>
                <option value="en">English</option>
                <option value="hi">हिंदी</option>
              </select>
            </Field>
            <div className="space-y-2 rounded-lg border border-line bg-slate-50/60 p-3 text-[13px] sm:col-span-2">
              <p className="font-medium">{t("patient.privacyTitle")}</p>
              <p className="text-ink-muted">{t("patient.privacyBody")}</p>
              <p className="text-ink-muted">{t("patient.aadhaarNote")}</p>
              {([
                ["consentData", t("patient.consentData")],
                ["consentLocation", t("patient.consentLocation")],
                ["consentSms", t("patient.consentSms")],
              ] as const).map(([k, label]) => (
                <label key={k} className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5 size-4 accent-brand-600" checked={details[k]} onChange={(e) => setDetails({ ...details, [k]: e.target.checked })} />
                  {label}
                </label>
              ))}
            </div>
            {formError && (
              <Notice tone="critical" className="sm:col-span-2">
                {tx(formError)}
              </Notice>
            )}
            <div className="sm:col-span-2">
              <button type="submit" disabled={pending || !step1Ready} className={buttonClass("primary")}>
                {pending ? t("common.submitting") : t("patient.submit")}
              </button>
            </div>
          </CardBody>
        </Card>
      )}
    </form>
  );
}
