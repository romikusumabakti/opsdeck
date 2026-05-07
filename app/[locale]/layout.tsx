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
import { CommandPalette } from "@/components/command-palette";
import { DialogProvider } from "@/components/dialog-provider";
import { HeaderBreadcrumb } from "@/components/header-breadcrumb";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ServerTime } from "@/components/server-time";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import { Toaster } from "@/components/ui/sonner";
import { UserMenu } from "@/components/user-menu";
import { Link } from "@/i18n/navigation";
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
                <header className="flex border-b h-14 shrink-0 items-center gap-2 px-4 bg-background sticky top-0 z-30">
                  <Link
                    href="/"
                    className="flex items-center gap-2 font-semibold hover:opacity-90 transition-opacity shrink-0"
                  >
                    <span className="size-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center shrink-0">
                      <Aperture className="size-4" />
                    </span>
                    <span className="truncate hidden sm:inline">
                      {t("name")}
                    </span>
                  </Link>
                  <HeaderBreadcrumb projects={projects} />
                  <div className="ml-auto flex items-center gap-1">
                    <div className="hidden md:flex items-center gap-2 pr-1">
                      <ServerTime />
                      <Separator orientation="vertical" className="!h-5" />
                    </div>
                    <CommandPalette projects={projects} />
                    <UserMenu user={session.user} />
                  </div>
                </header>
              ) : (
                <div className="fixed top-3 right-4 z-50 flex items-center gap-1">
                  <LocaleSwitcher />
                  <ThemeToggle />
                </div>
              )}
              <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
                {children}
              </div>
              {session && <KeyboardShortcuts />}
              <Toaster />
            </DialogProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
