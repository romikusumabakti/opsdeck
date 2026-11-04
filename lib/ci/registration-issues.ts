import type { z } from "zod";
import {
  REGISTRATION_ISSUES,
  type RegistrationIssue,
} from "@/lib/ci/registration";

// Turns a registerAppSchema issue into a message key of the `appForm.issues`
// catalogue, so the register form never shows zod's or a shared schema's
// English text. Pure and client-safe.

export const ISSUE_KEYS = [
  ...REGISTRATION_ISSUES,
  "required",
  "atLeastOne",
  "tooShort",
  "tooLong",
  "tooSmall",
  "tooLarge",
  "notANumber",
  "invalidKey",
  "invalidBranch",
  "invalidImageName",
  "invalidImage",
  "invalidStepName",
  "reservedStepName",
  "invalidPath",
  "duplicateImage",
  "duplicateBundleTarget",
  "duplicateCheck",
  "invalid",
] as const;
export type IssueKey = (typeof ISSUE_KEYS)[number];

export type IssueMessage = {
  key: IssueKey;
  values?: Record<string, string | number>;
};

type Issue = z.core.$ZodIssue;

function isRegistrationIssue(message: string): message is RegistrationIssue {
  return (REGISTRATION_ISSUES as readonly string[]).includes(message);
}

/** The last string segment of the path: the field the issue is about. */
function fieldOf(path: readonly PropertyKey[]): string {
  for (let i = path.length - 1; i >= 0; i--) {
    if (typeof path[i] === "string") return path[i] as string;
  }
  return "";
}

const PATH_FIELDS = new Set(["dockerfile", "context", "from", "to", "dir"]);

/** A field whose value failed its format (regex or refine). */
function formatKey(path: readonly PropertyKey[]): IssueKey {
  const field = fieldOf(path);
  const inChecks = path.includes("checks");
  if (field === "appKey" || field === "componentKey") return "invalidKey";
  if (field === "branches") return "invalidBranch";
  if (field === "name")
    return inChecks ? "invalidStepName" : "invalidImageName";
  if (field === "image") return "invalidImage";
  if (PATH_FIELDS.has(field)) return "invalidPath";
  return "invalid";
}

export function issueMessage(issue: Issue): IssueMessage {
  switch (issue.code) {
    case "custom": {
      if (isRegistrationIssue(issue.message)) {
        const values = issue.params as Record<string, string> | undefined;
        return values ? { key: issue.message, values } : { key: issue.message };
      }
      // Shared build-spec and deploy-validation refinements.
      const field = fieldOf(issue.path);
      if (issue.message.startsWith("Duplicate image")) {
        return { key: "duplicateImage" };
      }
      if (issue.message.startsWith("Duplicate bundle")) {
        return { key: "duplicateBundleTarget" };
      }
      if (issue.message.startsWith("Duplicate check")) {
        return { key: "duplicateCheck" };
      }
      if (field === "name" && issue.path.includes("checks")) {
        return { key: "reservedStepName" };
      }
      return { key: formatKey(issue.path) };
    }
    case "invalid_format":
    case "invalid_union":
      return { key: formatKey(issue.path) };
    case "too_small":
      if (issue.origin === "array") return { key: "atLeastOne" };
      if (issue.origin === "string") {
        return Number(issue.minimum) <= 1
          ? { key: "required" }
          : { key: "tooShort", values: { min: Number(issue.minimum) } };
      }
      return { key: "tooSmall", values: { min: Number(issue.minimum) } };
    case "too_big":
      if (issue.origin === "string" || issue.origin === "array") {
        return { key: "tooLong", values: { max: Number(issue.maximum) } };
      }
      return { key: "tooLarge", values: { max: Number(issue.maximum) } };
    case "invalid_type":
      return issue.expected === "number"
        ? { key: "notANumber" }
        : { key: "required" };
    default:
      return { key: "invalid" };
  }
}
