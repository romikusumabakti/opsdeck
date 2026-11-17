import { describe, expect, it } from "vitest";
import {
  contextFromRow,
  contextListLabel,
  questionContextInputSchema,
} from "@/lib/assistant/context";

const PROJECT = "0197f3a0-1b2c-7def-8000-00000000a001";
const ENV = "0197f3a0-1b2c-7def-8000-00000000e001";

describe("contextFromRow", () => {
  it.each([
    [
      "auto: no project, no environment, no names",
      {
        projectId: null,
        projectName: null,
        environmentId: null,
        environmentName: null,
      },
      { kind: "auto" },
    ],
    [
      "a pinned project",
      {
        projectId: PROJECT,
        projectName: "Acme",
        environmentId: null,
        environmentName: null,
      },
      { kind: "project", projectId: PROJECT, projectName: "Acme" },
    ],
    [
      "a pinned environment",
      {
        projectId: PROJECT,
        projectName: "Acme",
        environmentId: ENV,
        environmentName: "Staging",
      },
      {
        kind: "environment",
        environmentId: ENV,
        environmentName: "Staging",
        projectId: PROJECT,
        projectName: "Acme",
      },
    ],
    [
      "a deleted project (id nulled, name kept)",
      {
        projectId: null,
        projectName: "Acme",
        environmentId: null,
        environmentName: null,
      },
      { kind: "gone", of: "project", label: "Acme" },
    ],
    [
      "a deleted environment of a live project",
      {
        projectId: PROJECT,
        projectName: "Acme",
        environmentId: null,
        environmentName: "Staging",
      },
      { kind: "gone", of: "environment", label: "Staging" },
    ],
    [
      "a deleted environment of a deleted project",
      {
        projectId: null,
        projectName: "Acme",
        environmentId: null,
        environmentName: "Staging",
      },
      { kind: "gone", of: "environment", label: "Staging" },
    ],
  ])("%s", (_label, row, expected) => {
    expect(contextFromRow(row)).toEqual(expected);
  });
});

describe("questionContextInputSchema", () => {
  it.each([
    { kind: "auto" },
    { kind: "project", projectId: PROJECT },
    { kind: "environment", environmentId: ENV },
  ])("accepts %o", (input) => {
    expect(questionContextInputSchema.parse(input)).toEqual(input);
  });

  it.each([
    {},
    { kind: "project" },
    { kind: "project", projectId: "not-a-uuid" },
    { kind: "environment", projectId: PROJECT },
    { kind: "everything" },
    { kind: "auto", projectId: PROJECT },
  ])("rejects %o", (input) => {
    expect(questionContextInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("contextListLabel", () => {
  const row = {
    projectId: PROJECT,
    projectName: "Kestrel Membership",
    environmentId: ENV,
    environmentName: "Dev 1",
  };

  it("names an environment with its project, as the question bubble does", () => {
    expect(contextListLabel(row)).toBe("Kestrel Membership · Dev 1");
  });

  it("drops the project prefix an environment name repeats", () => {
    expect(
      contextListLabel({ ...row, environmentName: "Kestrel Membership Dev 1" })
    ).toBe("Kestrel Membership · Dev 1");
  });

  it("keeps the project name for a deleted environment and marks it", () => {
    expect(contextListLabel({ ...row, environmentId: null })).toBe(
      "Kestrel Membership · Dev 1 (deleted)"
    );
  });

  it("marks a deleted project", () => {
    expect(
      contextListLabel({
        projectId: null,
        projectName: "Kestrel Membership",
        environmentId: null,
        environmentName: null,
      })
    ).toBe("Kestrel Membership (deleted)");
  });

  it("a project, a deleted project and automatic", () => {
    const project = { ...row, environmentId: null, environmentName: null };
    expect(contextListLabel(project)).toBe("Kestrel Membership");
    expect(
      contextListLabel({
        projectId: null,
        projectName: null,
        environmentId: null,
        environmentName: null,
      })
    ).toBeNull();
  });
});
