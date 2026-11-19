import { useTranslations } from "use-intl";
import { ApiError } from "@/web/api/client";

const GROUP_CODES = new Set([
  "groupNameTaken",
  "groupNotFound",
  "groupMergeSelf",
  "groupReorderInvalid",
]);

/** The words for a refused group write: its coded message, else `fallback`. */
export function useGroupErrorMessage(): (
  error: unknown,
  fallback: string
) => string {
  const t = useTranslations("actionErrors");
  return (error, fallback) =>
    error instanceof ApiError && error.code && GROUP_CODES.has(error.code)
      ? t(error.code)
      : fallback;
}
