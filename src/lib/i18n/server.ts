import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { createTranslator, getDictionary, LOCALE_COOKIE, normalizeLocale, type Locale } from "./index";

export const getLocale = cache(async (): Promise<Locale> => {
  const store = await cookies();
  return normalizeLocale(store.get(LOCALE_COOKIE)?.value);
});

export const getI18n = cache(async () => {
  const locale = await getLocale();
  const dict = getDictionary(locale);
  return { locale, dict, ...createTranslator(dict) };
});
