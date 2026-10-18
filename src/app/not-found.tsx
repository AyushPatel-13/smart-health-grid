import Link from "next/link";
import { getI18n } from "@/lib/i18n/server";

export default async function NotFound() {
  const { t } = await getI18n();
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="max-w-md rounded-xl border border-line bg-white p-6 text-center">
        <p className="font-mono text-sm text-ink-muted">404</p>
        <h1 className="mt-1 text-lg font-semibold">{t("empty.title")}</h1>
        <Link href="/dashboard" className="mt-4 inline-flex h-9 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white">
          {t("nav.dashboard")}
        </Link>
      </div>
    </div>
  );
}
