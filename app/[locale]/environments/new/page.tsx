import { notFound, redirect } from "next/navigation";
import { getProject } from "@/actions/project-catalog";

// Creating an environment is now scoped to its parent project
// (`/[KEY]/environments/new`). This shim keeps the old flat URL alive:
// `?project=<id>` resolves to that project's key, and a bare hit (no parent to
// infer) falls back to the projects list, where every card offers the action.
export default async function LegacyNewEnvironmentRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string; project?: string }>;
}) {
  const [{ locale }, { from, project }] = await Promise.all([
    params,
    searchParams,
  ]);
  if (!project) {
    redirect(`/${locale}/projects`);
  }
  const parent = await getProject(project);
  if (!parent) notFound();
  const suffix = from ? `?from=${encodeURIComponent(from)}` : "";
  redirect(`/${locale}/${parent.key}/environments/new${suffix}`);
}
