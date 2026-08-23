import type { Locale } from "date-fns";
import { ar as arLocale } from "date-fns/locale/ar";
import { es as esLocale } from "date-fns/locale/es";
import { id as idLocale } from "date-fns/locale/id";
import { zhCN as zhCNLocale } from "date-fns/locale/zh-CN";

const localeMap: Partial<Record<string, Locale>> = {
  es: esLocale,
  id: idLocale,
  zh: zhCNLocale,
  ar: arLocale,
};

export function getDateFnsLocale(locale: string): Locale | undefined {
  return localeMap[locale];
}
