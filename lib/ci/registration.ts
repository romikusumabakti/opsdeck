import { z } from "zod";
import { buildSpecSchema } from "@/lib/ci/build-spec";
import {
  appKeySchema,
  bundleImageSchema,
  componentKeySchema,
} from "@/lib/deploy/validation";
import { uuidSchema } from "@/lib/validation";

// The app registration payload, shared by the API (server/services/apps.ts)
// and the register form, so both reject the same input. Client-safe.

/** The image a component's pipeline pushes its deploy bundle to. */
export function bundleImageFor(componentKey: string): string {
  return `${componentKey}-deploy`;
}

export const PIPELINE_MODES = ["custom", "generated"] as const;

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
        message: `Bundle image must be ${bundle}`,
      });
    }
    if (c.pipelineMode === "generated" && !c.buildSpec) {
      ctx.addIssue({
        code: "custom",
        path: ["buildSpec"],
        message: "A generated pipeline needs a build spec",
      });
    }
    if (c.pipelineMode === "custom" && c.buildSpec) {
      ctx.addIssue({
        code: "custom",
        path: ["buildSpec"],
        message: "A custom pipeline has no build spec",
      });
    }
    // The generated pipeline pushes the bundle under this name; a build image
    // with the same name would be overwritten by it (or overwrite it).
    c.buildSpec?.images.forEach((image, index) => {
      if (image.name === bundle) {
        ctx.addIssue({
          code: "custom",
          path: ["buildSpec", "images", index, "name"],
          message: `Image name ${bundle} is the deploy bundle's`,
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
          message: "Duplicate component key",
        });
      }
      keys.add(c.componentKey);
      const repo = `${c.ciConnectionId}\n${c.forgeRemoteId}`;
      if (repos.has(repo)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", index, "forgeRemoteId"],
          message: "Duplicate repository",
        });
      }
      repos.add(repo);
    });
  });

export type RegisterAppInput = z.infer<typeof registerAppSchema>;
export type RegisterComponentInput = z.infer<typeof registerComponentSchema>;
