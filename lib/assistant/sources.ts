import {
  type RunningSource,
  resolveRunningSources,
} from "@/lib/running-sources";

/**
 * One code source the assistant may read for an environment: a running source
 * (lib/running-sources) without its deployed tag, so the stored conversation
 * sources and the system prompt keep their shape. An automatic question reads
 * several projects, so each source it opened also names its project (absent
 * on pinned questions: their project is the question's).
 */
export type AssistantSource = Omit<RunningSource, "tag"> & {
  projectKey?: string;
  projectName?: string;
};

/** Every deploy target of the environment with the commit it runs. */
export async function resolveEnvironmentSources(
  environmentId: string
): Promise<AssistantSource[]> {
  return (await resolveRunningSources(environmentId)).map(
    ({ tag: _tag, ...source }) => source
  );
}
