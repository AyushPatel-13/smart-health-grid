import { hasKey, type Locale, type TxFunction } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n/en";

export interface AlertLike {
  category: string;
  title: string;
  supporting_values: Record<string, unknown> | null;
}

/**
 * English uses the stored engine text. Other locales render the category
 * template with the stored supporting values (numbers and IDs unchanged),
 * falling back to the stored title for manual alerts.
 */
export function alertTitle(a: AlertLike, locale: Locale, tx: TxFunction, dict: Dictionary): string {
  if (locale === "en" || a.category === "manual") return a.title;
  const key = `alerts.templates.${a.category}`;
  if (!hasKey(dict, key)) return a.title;
  const v = (a.supporting_values ?? {}) as Record<string, string | number | null>;
  return tx(key, v);
}
