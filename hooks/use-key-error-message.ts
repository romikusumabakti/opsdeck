import { useTranslations } from "use-intl";

/**
 * The sentence for a stored key error or job result code (actionErrors), or
 * the code itself when no message exists for it.
 */
export function useKeyErrorMessage(): (code: string) => string {
  const t = useTranslations("actionErrors");
  return (code) => (t.has(code as never) ? t(code as never) : code);
}
