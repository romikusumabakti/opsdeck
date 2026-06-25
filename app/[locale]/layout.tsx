import type { Metadata } from "next";
import { Geist, Geist_Mono, Noto_Sans_Arabic } from "next/font/google";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import {
  getMessages,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { getProjects } from "@/actions/projects";
import { ActiveTasksIndicator } from "@/components/active-tasks-indicator";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { DialogProvider } from "@/components/dialog-provider";
import { HeaderBreadcrumb } from "@/components/header-breadcrumb";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { NavigationGuardProvider } from "@/components/navigation-guard";
import { ServerTime } from "@/components/server-time";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { isRtlLocale } from "@/i18n/locales";
import { routing } from "@/i18n/routing";
import { getServerSession, isAdmin } from "@/lib/auth-session";
import { APP_TIMEZONE } from "@/lib/timezone";
import "../globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const notoSansArabic = Noto_Sans_Arabic({
  variable: "--font-noto-sans-arabic",
  subsets: ["arabic"],
  weight: ["400", "500", "600", "700"],
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
  const rtl = isRtlLocale(locale as Parameters<typeof isRtlLocale>[0]);

  const session = await getServerSession();
  const projects = session ? await getProjects() : [];
  const admin = session ? isAdmin(session) : false;
  const messages = await getMessages({ locale });
  const tHeader = await getTranslations({ locale, namespace: "header" });

  // Sidebar open state is persisted in a cookie by the SidebarProvider client;
  // read it on the server so the initial render matches and avoids a flash.
  const sidebarStateCookie = (await cookies()).get("sidebar_state")?.value;
  const sidebarDefaultOpen = sidebarStateCookie !== "false";

  return (
    <html lang={locale} dir={rtl ? "rtl" : "ltr"} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${notoSansArabic.variable} antialiased`}
        style={
          rtl
            ? { fontFamily: "var(--font-noto-sans-arabic), sans-serif" }
            : undefined
        }
      >
        <NextIntlClientProvider
          locale={locale}
          messages={messages}
          timeZone={APP_TIMEZONE}
        >
          <ThemeProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
          >
            <DialogProvider>
              <NavigationGuardProvider>
                {session ? (
                  <SidebarProvider defaultOpen={sidebarDefaultOpen}>
                    <a
                      href="#main-content"
                      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground focus:shadow-md focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    >
                      {tHeader("skipToContent")}
                    </a>
                    <AppSidebar
                      projects={projects}
                      isAdmin={admin}
                      side={rtl ? "right" : "left"}
                      user={{
                        id: session.user.id,
                        name: session.user.name,
                        email: session.user.email,
                        image: session.user.image ?? null,
                      }}
                    />
                    <SidebarInset className="min-w-0">
                      <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-4">
                        <SidebarTrigger className="-ms-1" />
                        <HeaderBreadcrumb projects={projects} isAdmin={admin} />
                        <div className="ms-auto flex items-center gap-2">
                          <ActiveTasksIndicator />
                          <div className="hidden md:flex items-center gap-2 pe-1">
                            <ServerTime timeZone={APP_TIMEZONE} />
                          </div>
                          <CommandPalette projects={projects} isAdmin={admin} />
                        </div>
                      </header>
                      <main
                        id="main-content"
                        tabIndex={-1}
                        className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-6 px-4 sm:px-6 lg:px-8 py-6 focus:outline-none"
                      >
                        {children}
                      </main>
                    </SidebarInset>
                    <KeyboardShortcuts />
                  </SidebarProvider>
                ) : (
                  <div className="flex flex-col min-h-screen">
                    <div className="fixed top-3 right-4 z-50 flex items-center gap-1">
                      <LocaleSwitcher />
                      <ThemeToggle />
                    </div>
                    <div className="flex-1 min-h-0 flex flex-col">
                      {children}
                    </div>
                  </div>
                )}
                <Toaster />
              </NavigationGuardProvider>
            </DialogProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
