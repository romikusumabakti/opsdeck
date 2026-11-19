import { z } from "zod";
import { buildSpecSchema } from "@/lib/ci/build-spec";
import {
  appKeySchema,
  bundleImageSchema,
  componentKeySchema,
} from "@/lib/deploy/validation";
import { uuidSchema } from "@/lib/validation";

// The registration payloads (services, and the New environment page's app),
// shared by the API (server/services/apps.ts) and the register forms, so both
// reject the same input. Client-safe.

/** The image a component's pipeline pushes its deploy bundle to. */
export function bundleImageFor(componentKey: string): string {
  return `${componentKey}-deploy`;
}

/**
 * The component that stands for a repository building several (a container
 * component and legacy artifact ones): the first that is not an artifact
 * component, else the first. Deterministic whatever order apps are listed in.
 */
export function repoRepresentative<
  T extends { buildSpec?: { artifact?: unknown } | null },
>(matches: readonly T[]): T | undefined {
  return matches.find((c) => !c.buildSpec?.artifact) ?? matches[0];
}

export const PIPELINE_MODES = ["custom", "generated"] as const;

/**
 * The custom issues this schema raises. Each issue's `message` is one of
 * these stable keys (with `params` for its values), which the form
 * translates (lib/ci/registration-issues.ts); the API answers a plain 400.
 */
export const REGISTRATION_ISSUES = [
  "bundleImageMismatch",
  "buildSpecRequired",
  "buildSpecNotAllowed",
  "imageIsBundle",
  "duplicateComponentKey",
  "duplicateRepo",
  "sharedPipelineBranch",
] as const;
export type RegistrationIssue = (typeof REGISTRATION_ISSUES)[number];

export const registerComponentSchema = z
  .object({
    componentKey: componentKeySchema,
    ciConnectionId: uuidSchema,
    // Woodpecker's forge id of the repo, e.g. a Bitbucket "{uuid}".
    forgeRemoteId: z.string().trim().min(1).max(255),
    bundleImage: bundleImageSchema,
    pipelineMode: z.enum(PIPELINE_MODES),
    buildSpec: buildSpecSchema.optional(),
  })
  .superRefine((c, ctx) => {
    const bundle = bundleImageFor(c.componentKey);
    if (c.bundleImage !== bundle) {
      ctx.addIssue({
        code: "custom",
        path: ["bundleImage"],
        message: "bundleImageMismatch",
        params: { bundle },
      });
    }
    if (c.pipelineMode === "generated" && !c.buildSpec) {
      ctx.addIssue({
        code: "custom",
        path: ["buildSpec"],
        message: "buildSpecRequired",
      });
    }
    if (c.pipelineMode === "custom" && c.buildSpec) {
      ctx.addIssue({
        code: "custom",
        path: ["buildSpec"],
        message: "buildSpecNotAllowed",
      });
    }
    // The generated pipeline pushes the bundle under this name; a build image
    // with the same name would be overwritten by it (or overwrite it).
    c.buildSpec?.images.forEach((image, index) => {
      if (image.name === bundle) {
        ctx.addIssue({
          code: "custom",
          path: ["buildSpec", "images", index, "name"],
          message: "imageIsBundle",
          params: { bundle },
        });
      }
    });
  });

export const registerAppSchema = z
  .object({
    appKey: appKeySchema,
    name: z.string().trim().min(1).max(120),
    components: z.array(registerComponentSchema).min(1).max(20),
  })
  .superRefine((app, ctx) => {
    const keys = new Set<string>();
    const repos = new Set<string>();
    app.components.forEach((c, index) => {
      if (keys.has(c.componentKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "componentKey"],
          message: "duplicateComponentKey",
        });
      }
      keys.add(c.componentKey);
      const repo = `${c.ciConnectionId}\n${c.forgeRemoteId}`;
      if (repos.has(repo)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "forgeRemoteId"],
          message: "duplicateRepo",
        });
      }
      repos.add(repo);
    });
  });

export type RegisterAppInput = z.infer<typeof registerAppSchema>;
export type RegisterComponentInput = z.infer<typeof registerComponentSchema>;

/**
 * Registers one or more services directly (no app): several may come from one
 * repository, each under its own notify secret. Generated services of one
 * repository must build different branches, since a branch holds one
 * generated `.woodpecker.yaml`.
 */
export const registerServicesSchema = z
  .object({ services: z.array(registerComponentSchema).min(1).max(20) })
  .superRefine((input, ctx) => {
    const keys = new Set<string>();
    const branchesOf = new Map<string, Set<string>>();
    input.services.forEach((c, index) => {
      if (keys.has(c.componentKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["services", index, "componentKey"],
          message: "duplicateComponentKey",
        });
      }
      keys.add(c.componentKey);
      if (!c.buildSpec) return;
      const repo = `${c.ciConnectionId}\n${c.forgeRemoteId}`;
      const taken = branchesOf.get(repo) ?? new Set<string>();
      const branch = c.buildSpec.branches.find((b) => taken.has(b));
      if (branch !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["services", index, "buildSpec", "branches"],
          message: "sharedPipelineBranch",
          params: { branch },
        });
      }
      for (const b of c.buildSpec.branches) taken.add(b);
      branchesOf.set(repo, taken);
    });
  });

export type RegisterServicesInput = z.infer<typeof registerServicesSchema>;
