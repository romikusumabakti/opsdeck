import { Aperture } from "lucide-react";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import {
  getMessages,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { getProjects } from "@/actions/projects";
import { DialogProvider } from "@/components/dialog-provider";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { SelectProject } from "@/components/select-project";
import { ServerTime } from "@/components/server-time";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { routing } from "@/i18n/routing";
import { getServerSession } from "@/lib/auth-session";
import "../globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "app" });
  return {
    title: t("name"),
    description: t("name"),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);

  const session = await getServerSession();
  const projects = session ? await getProjects() : [];
  const t = await getTranslations({ locale, namespace: "app" });
  const messages = await getMessages({ locale });

  return (
    <html lang={locale} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased flex flex-col h-screen`}
      >
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <DialogProvider>
              {session ? (
                <header className="flex border-b h-14 shrink-0 sticky top-0 z-40 bg-background">
                  <div className="flex w-64 px-6 items-center">
                    <h1 className="font-bold flex gap-2">
                      <Aperture />
                      <span>{t("name")}</span>
                    </h1>
                  </div>
                  <div className="flex items-center flex-1">
                    <SelectProject projects={projects} />
                  </div>
                  <div className="flex items-center gap-2 px-4">
                    <ServerTime />
                    <LocaleSwitcher />
                    <ThemeToggle />
                    <UserMenu user={session.user} />
                  </div>
                </header>
              ) : (
                <div className="fixed top-3 right-4 z-50 flex items-center gap-2">
                  <LocaleSwitcher />
                  <ThemeToggle />
                </div>
              )}
              {children}
            </DialogProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
