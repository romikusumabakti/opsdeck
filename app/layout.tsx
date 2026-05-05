import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import "./globals.css";
import { Aperture } from "lucide-react";
import { getProjects } from "@/actions/projects";
import { DialogProvider } from "@/components/dialog-provider";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { SelectProject } from "@/components/select-project";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { getServerSession } from "@/lib/auth-session";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return {
    title: t("name"),
    description: t("name"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const session = await getServerSession();
  const projects = session ? await getProjects() : [];
  const locale = await getLocale();
  const messages = await getMessages();
  const t = await getTranslations("app");

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
                <header className="flex border-b h-14 shrink-0">
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
