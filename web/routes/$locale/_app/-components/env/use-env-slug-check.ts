import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { envSlugProblem } from "@/lib/setup/slug";
import { checkEnvironmentSlugQuery } from "@/web/api/environments";

const CHECK_DEBOUNCE_MS = 400;

/**
 * The live verdict on a URL name typed into a form: the shared rules at
 * once (lib/setup/slug), then — once typing pauses — whether the project
 * already uses it (GET /api/environments/check-slug). `code` is an
 * actionErrors key, null when the slug is free; `checking` while the answer
 * for the slug on screen is not in yet. `slug` null skips the check (the
 * field holds the environment's own slug, or is left at its default).
 */
export function useEnvSlugCheck(
  projectId: string,
  slug: string | null,
  environmentId?: string
): { code: string | null; checking: boolean } {
  const problem = slug === null ? null : envSlugProblem(slug);
  const debounced = useDebouncedValue(slug, CHECK_DEBOUNCE_MS);
  const wanted = slug !== null && problem === null && !!projectId;
  const answer = useQuery({
    ...checkEnvironmentSlugQuery(projectId, debounced ?? "", environmentId),
    enabled: wanted && debounced === slug,
  });
  if (problem) return { code: problem, checking: false };
  if (!wanted) return { code: null, checking: false };
  if (debounced !== slug || answer.isPending) {
    return { code: null, checking: true };
  }
  return { code: answer.data?.code ?? null, checking: false };
}
