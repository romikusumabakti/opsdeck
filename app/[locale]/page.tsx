import { getProjects } from "@/actions/projects";
import { ProjectsEmpty } from "@/components/projects-empty";
import { redirect } from "@/i18n/navigation";

export default async function Home() {
  const projects = await getProjects();

  if (projects.length === 0) {
    return <ProjectsEmpty />;
  }

  await redirect(`/projects/${projects[0].id}`);
}
