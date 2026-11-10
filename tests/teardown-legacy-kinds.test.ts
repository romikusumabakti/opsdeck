import { describe, expect, it } from "vitest";
import { planTeardown } from "@/lib/teardown/plan";
import type { TeardownEnvironment } from "@/lib/teardown/repository";

const target = (
  deployDir: string,
  kind?: "compose" | "jar" | "static"
): TeardownEnvironment["targets"][number] => ({
  serverId: "srv-1",
  host: "app-1.lan",
  deployDir,
  ...(kind ? { kind } : {}),
});

const env = (targets: TeardownEnvironment["targets"]): TeardownEnvironment => ({
  targets,
  otherTargets: [],
  dbServices: [],
  domain: null,
  otherDomains: [],
});

const stepsOf = (e: TeardownEnvironment) => {
  const plan = planTeardown(e);
  if ("refusal" in plan) throw new Error(plan.refusal);
  return plan.steps;
};

describe("teardown of legacy deploy kinds", () => {
  it("plans server steps only for the compose directory", () => {
    const steps = stepsOf(
      env([target("/opt/stack", "compose"), target("/opt/jar", "jar")])
    );
    const dirSteps = steps.filter((s) => "deployDir" in s.params);
    expect(dirSteps.length).toBeGreaterThan(0);
    for (const step of dirSteps) {
      expect(step.params).toMatchObject({ deployDir: "/opt/stack" });
    }
    expect(steps.at(-1)?.kind).toBe("delete_environment");
  });

  it("plans only the environment removal for static-only targets", () => {
    expect(
      stepsOf(env([target("/var/www/site", "static")])).map((s) => s.kind)
    ).toEqual(["delete_environment"]);
  });

  it("does not refuse an unsafe directory of a jar target", () => {
    expect(stepsOf(env([target("/", "jar")])).map((s) => s.kind)).toEqual([
      "delete_environment",
    ]);
  });

  it("treats a target without a kind as compose", () => {
    expect(stepsOf(env([target("/opt/stack")])).map((s) => s.kind)).toContain(
      "stack_down"
    );
  });
});
