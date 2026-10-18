import type { Metadata, Viewport } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n/client";
import { getI18n } from "@/lib/i18n/server";

export const metadata: Metadata = {
  title: { default: "Smart Health Grid", template: "%s · Smart Health Grid" },
  description: "AI-assisted healthcare resource management for PHCs and CHCs (demo with synthetic data).",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b1f3a",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const { locale, dict } = await getI18n();
  return (
    <html lang={locale} className="h-full antialiased">
      <body className="min-h-full">
        <I18nProvider locale={locale} dict={dict}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
