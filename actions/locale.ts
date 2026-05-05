"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { isValidLocale, LOCALE_COOKIE, type Locale } from "@/i18n/locales";

export async function setLocale(locale: Locale) {
  if (!isValidLocale(locale)) return;
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  revalidatePath("/", "layout");
}
