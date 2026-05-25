import type { Locale } from "date-fns";
import { ar as arLocale } from "date-fns/locale/ar";
import { id as idLocale } from "date-fns/locale/id";
import { zhCN as zhCNLocale } from "date-fns/locale/zh-CN";

const localeMap: Partial<Record<string, Locale>> = {
  id: idLocale,
  zh: zhCNLocale,
  ar: arLocale,
};

export function getDateFnsLocale(locale: string): Locale | undefined {
  return localeMap[locale];
}
