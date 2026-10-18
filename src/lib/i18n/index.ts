import en, { type Dictionary } from "./en";
import hi from "./hi";

export type Locale = "en" | "hi";
export const LOCALES: Locale[] = ["en", "hi"];
export const LOCALE_COOKIE = "shg_lang";

type Paths<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Paths<T[K], `${P}${K}.`>;
}[keyof T & string];

export type TKey = string;
export type TParams = Record<string, string | number | null | undefined>;
export type TFunction = (key: TKey, params?: TParams) => string;
/** Untyped variant for keys computed at runtime (e.g. from analytics reasons). */
export type TxFunction = (key: string, params?: TParams) => string;

const dictionaries: Record<Locale, Dictionary> = { en, hi };

export function getDictionary(locale: Locale): Dictionary {
  return dictionaries[locale] ?? en;
}

export function normalizeLocale(value: string | undefined | null): Locale {
  return value === "hi" ? "hi" : "en";
}

function lookup(dict: unknown, key: string): string | undefined {
  let cur: unknown = dict;
  for (const part of key.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

export function interpolate(template: string, params?: TParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const v = params[name];
    return v === null || v === undefined ? "—" : typeof v === "number" ? formatNumber(v) : String(v);
  });
}

export function hasKey(dict: Dictionary, key: string): boolean {
  return lookup(dict, key) !== undefined;
}

export function createTranslator(dict: Dictionary): { t: TFunction; tx: TxFunction } {
  const tx: TxFunction = (key, params) => {
    const template = lookup(dict, key) ?? lookup(en, key) ?? key;
    return interpolate(template, params);
  };
  return { t: tx as TFunction, tx };
}

// ---------------------------------------------------------------------------
// Formatting. Numerals stay in Western digits in both languages (Indian
// grouping) so resource identifiers and figures are identical across locales.
// ---------------------------------------------------------------------------
const numberFormat = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

export function formatNumber(n: number | null | undefined, digits?: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  if (digits !== undefined) {
    return new Intl.NumberFormat("en-IN", { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(n);
  }
  return numberFormat.format(n);
}

export function formatPct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return "—";
  return `${Math.round(ratio * 100)}%`;
}

function intlLocale(locale: Locale) {
  return locale === "hi" ? "hi-IN-u-nu-latn" : "en-IN";
}

export function formatDay(day: string | null | undefined, locale: Locale): string {
  if (!day) return "—";
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(intlLocale(locale), { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export function formatShortDay(day: string, locale: Locale): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Intl.DateTimeFormat(intlLocale(locale), { day: "2-digit", month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

export function formatDateTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  }).format(new Date(iso));
}

export function formatRelative(iso: string | null | undefined, t: TFunction, now = Date.now()): string {
  if (!iso) return t("common.never");
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 2) return t("common.justNow");
  if (mins < 60) return t("common.ago", { value: t("common.minutesShort", { n: mins }) });
  const hours = Math.round(mins / 60);
  if (hours < 48) return t("common.ago", { value: t("common.hoursShort", { n: hours }) });
  return t("common.ago", { value: t("common.daysShort", { n: Math.round(hours / 24) }) });
}

/** Pick the Hindi name when available and the locale is Hindi. */
export function localName(row: { name: string; name_hi?: string | null }, locale: Locale): string {
  return locale === "hi" && row.name_hi ? row.name_hi : row.name;
}
