import { redirect } from "next/navigation";
import { getProjects } from "@/actions/projects";
import { ProjectsEmpty } from "@/components/projects-empty";

export default async function Home() {
  const projects = await getProjects();

  if (projects.length === 0) {
    return <ProjectsEmpty />;
  }

  redirect(`/projects/${projects[0].id}`);
}
