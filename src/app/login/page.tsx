import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { HeartPulse } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/user";
import { isDemoMode } from "@/lib/env";
import { getI18n } from "@/lib/i18n/server";
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from "@/lib/db/seed";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/dashboard");
  const { t } = await getI18n();
  const demo = isDemoMode();
  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      {demo && (
        <div className="bg-amber-100 px-4 py-1.5 text-center text-[12px] font-medium text-amber-900" role="region" aria-label={t("demo.badge")}>
          {t("demo.banner")}
        </div>
      )}
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="grid w-full max-w-4xl gap-6 md:grid-cols-[1.1fr_1fr]">
          <div className="hidden flex-col justify-between rounded-2xl bg-navy-900 p-8 text-white md:flex">
            <div>
              <span className="grid size-10 place-items-center rounded-xl bg-teal-600">
                <HeartPulse className="size-6" aria-hidden />
              </span>
              <p className="mt-6 text-2xl font-semibold">{t("app.name")}</p>
              <p className="mt-2 text-sm text-slate-300">{t("app.tagline")}</p>
            </div>
            <ul className="mt-8 space-y-2 text-sm text-slate-300">
              <li>• {t("nav.inventory")} · {t("nav.footfall")} · {t("nav.beds")}</li>
              <li>• {t("nav.attendance")} · {t("nav.diagnostics")}</li>
              <li>• {t("nav.forecasts")} · {t("nav.risk")} · {t("nav.redistribution")}</li>
            </ul>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
            <div className="mb-6 flex items-center gap-2 md:hidden">
              <HeartPulse className="size-6 text-teal-600" aria-hidden />
              <span className="font-semibold">{t("app.name")}</span>
            </div>
            <h1 className="text-xl font-semibold">{t("login.title")}</h1>
            <p className="mt-1 text-sm text-ink-muted">{demo ? t("login.subtitle") : t("login.supabaseHint")}</p>
            <LoginForm
              demoAccounts={demo ? DEMO_ACCOUNTS.map((a) => ({ email: a.email, fullName: a.fullName, role: a.role })) : []}
              demoPassword={demo ? DEMO_PASSWORD : null}
            />
          </div>
        </div>
      </main>
    </div>
  );
}
