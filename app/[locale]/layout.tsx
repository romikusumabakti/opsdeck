import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import {
  getMessages,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { getProjects } from "@/actions/projects";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { DialogProvider } from "@/components/dialog-provider";
import { HeaderBreadcrumb } from "@/components/header-breadcrumb";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { ServerTime } from "@/components/server-time";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Separator } from "@/components/ui/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { routing } from "@/i18n/routing";
import { getServerSession, isAdmin } from "@/lib/auth-session";
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
  const admin = session ? isAdmin(session) : false;
  const messages = await getMessages({ locale });

  // Sidebar open state is persisted in a cookie by the SidebarProvider client;
  // read it on the server so the initial render matches and avoids a flash.
  const sidebarStateCookie = (await cookies()).get("sidebar_state")?.value;
  const sidebarDefaultOpen = sidebarStateCookie !== "false";

  return (
    <html lang={locale} suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
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
                <SidebarProvider defaultOpen={sidebarDefaultOpen}>
                  <AppSidebar
                    projects={projects}
                    isAdmin={admin}
                    user={{
                      id: session.user.id,
                      name: session.user.name,
                      email: session.user.email,
                      image: session.user.image ?? null,
                    }}
                  />
                  <SidebarInset className="min-w-0">
                    <header className="flex h-14 shrink-0 items-center gap-2 px-4 border-b sticky top-0 z-30 bg-background">
                      <SidebarTrigger className="-ml-1" />
                      <Separator orientation="vertical" className="!h-5 mr-1" />
                      <HeaderBreadcrumb projects={projects} />
                      <div className="ml-auto flex items-center gap-2">
                        <div className="hidden md:flex items-center gap-2 pr-1">
                          <ServerTime />
                        </div>
                        <CommandPalette projects={projects} isAdmin={admin} />
                      </div>
                    </header>
                    <div className="flex-1 min-h-0 flex flex-col">
                      {children}
                    </div>
                  </SidebarInset>
                  <KeyboardShortcuts />
                </SidebarProvider>
              ) : (
                <div className="flex flex-col min-h-screen">
                  <div className="fixed top-3 right-4 z-50 flex items-center gap-1">
                    <LocaleSwitcher />
                    <ThemeToggle />
                  </div>
                  <div className="flex-1 min-h-0 flex flex-col">{children}</div>
                </div>
              )}
              <Toaster />
            </DialogProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
