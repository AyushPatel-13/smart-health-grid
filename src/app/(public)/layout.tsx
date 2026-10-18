import Link from "next/link";
import { HeartPulse } from "lucide-react";
import { LanguageSwitch } from "@/components/layout/app-shell";
import { isDemoMode } from "@/lib/env";
import { getI18n } from "@/lib/i18n/server";

export default async function PublicLayout({ children }: LayoutProps<"/">) {
  const { t } = await getI18n();
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      {isDemoMode() && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-[12px] font-medium text-amber-900" role="note">
          {t("demo.banner")}
        </div>
      )}
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-14 max-w-4xl items-center gap-3 px-4">
          <Link href="/register" className="flex items-center gap-2">
            <span className="grid size-8 place-items-center rounded-lg bg-teal-600 text-white">
              <HeartPulse className="size-5" aria-hidden />
            </span>
            <span className="text-sm font-semibold">{t("app.name")}</span>
          </Link>
          <nav className="ml-auto flex items-center gap-3 text-[13px]">
            <Link href="/register" className="hidden text-ink-muted hover:text-ink sm:inline">
              {t("patient.registerTitle")}
            </Link>
            <Link href="/patient" className="text-ink-muted hover:text-ink">
              {t("patient.checkStatus")}
            </Link>
            <LanguageSwitch />
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
        {children}
      </main>
      <footer className="border-t border-line bg-white py-3 text-center text-[12px] text-ink-muted">
        <Link href="/login" className="hover:text-ink">
          {t("patient.staffLogin")}
        </Link>
      </footer>
    </div>
  );
}
