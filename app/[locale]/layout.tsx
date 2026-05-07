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
import { Separator } from "@/components/ui/separator";
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
                <header className="flex border-b h-14 shrink-0 bg-background">
                  <div className="flex w-64 px-4 items-center shrink-0">
                    <Link
                      href="/"
                      className="flex items-center gap-2 font-semibold hover:opacity-90 transition-opacity"
                    >
                      <span className="size-8 rounded-md bg-primary text-primary-foreground flex items-center justify-center">
                        <Aperture className="size-4" />
                      </span>
                      <span className="truncate">{t("name")}</span>
                    </Link>
                  </div>
                  <div className="flex items-center flex-1 min-w-0 px-2">
                    <SelectProject projects={projects} />
                  </div>
                  <div className="flex items-center gap-1 px-3">
                    <div className="hidden lg:flex items-center pr-2">
                      <ServerTime />
                    </div>
                    <div className="hidden lg:flex h-5 items-center">
                      <Separator orientation="vertical" />
                    </div>
                    <LocaleSwitcher />
                    <ThemeToggle />
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
            </DialogProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
