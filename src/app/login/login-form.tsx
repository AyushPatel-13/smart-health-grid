"use client";

import { useState, useTransition } from "react";
import { loginAction } from "@/app/actions/auth";
import { useI18n } from "@/lib/i18n/client";
import { inputClass } from "@/components/ui/form";
import { Notice } from "@/components/ui/primitives";
import type { Role } from "@/lib/auth/permissions";

export function LoginForm({
  demoAccounts,
  demoPassword,
}: {
  demoAccounts: { email: string; fullName: string; role: Role }[];
  demoPassword: string | null;
}) {
  const { t, tx } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      // On success the action redirects; a returned value means failure.
      const res = await loginAction({ email, password });
      if (res && !res.ok) setError(res.error);
    });
  };

  return (
    <>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <div className="flex flex-col gap-1">
          <label htmlFor="email" className="text-[13px] font-medium">
            {t("login.email")}
          </label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="password" className="text-[13px] font-medium">
            {t("login.password")}
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </div>
        {error && <Notice tone="critical">{tx(error)}</Notice>}
        <button type="submit" disabled={pending} className="h-10 w-full rounded-lg bg-brand-600 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
          {pending ? t("common.loading") : t("login.submit")}
        </button>
      </form>

      {demoAccounts.length > 0 && demoPassword && (
        <div className="mt-6 border-t border-line pt-5">
          <p className="text-[13px] font-semibold">{t("login.demoAccounts")}</p>
          <p className="mt-1 text-xs text-ink-muted">
            {t("login.demoHint")} <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-ink">{demoPassword}</code>
          </p>
          <ul className="mt-3 space-y-1.5">
            {demoAccounts.map((a) => (
              <li key={a.email}>
                <button
                  type="button"
                  onClick={() => {
                    setEmail(a.email);
                    setPassword(demoPassword);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-left hover:border-brand-200 hover:bg-brand-50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{a.fullName}</span>
                    <span className="block truncate text-[11px] text-ink-muted">{a.email}</span>
                  </span>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-ink-muted">{t(`roles.${a.role}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
