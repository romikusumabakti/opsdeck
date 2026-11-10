import { z } from "zod";
import { branchSchema, bundleImageSchema } from "@/lib/deploy/validation";

// Inputs of a generated pipeline (lib/ci/pipeline.ts), stored as
// `app_components.build_spec`. Every value except check commands ends up
// unquoted in a shell line, so paths and names are restricted to characters
// that need no quoting; check commands are shell by design (only engineers
// edit them) and are escaped for Woodpecker, not for the shell.

// Names the generator gives its own steps; a check must not take one.
export const GENERATED_STEP_NAMES = ["build", "notify-panel"] as const;

// One path segment: no leading `-` (it would read as an option to `cp`), and
// not `.` or `..` (`..` escapes the workspace or the bundle dir).
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.][A-Za-z0-9._-]*$/;

/**
 * A relative path inside the repository: `/`-separated segments of letters,
 * digits, `.`, `_` and `-`, with no empty, `.` or `..` segment.
 */
const relativePath = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (path) => path.split("/").every((segment) => SEGMENT.test(segment)),
    "Path must be relative, without '..' or empty segments, using letters, digits, '.', '_' or '-'"
  );

// A build context or check directory: a relative path, or `.` for the root.
const directory = z.union([z.literal("."), relativePath]);

const stepName = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "Step name must be lowercase letters, digits or '-'"
  )
  .refine(
    (name) => !(GENERATED_STEP_NAMES as readonly string[]).includes(name),
    "Step name is reserved for a generated step"
  );

// A Docker image reference as the step's `image:` (registry, path, tag, digest).
const imageReference = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/,
    "Image must be a Docker image reference"
  );

const unique =
  <T>(key: (item: T) => string, message: string) =>
  (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const item of items) {
      const value = key(item);
      if (seen.has(value)) {
        ctx.addIssue({ code: "custom", message: `${message}: ${value}` });
        return;
      }
      seen.add(value);
    }
  };

/** One image of the build spec: its name, Dockerfile and build context. */
export const buildImageSchema = z.object({
  name: bundleImageSchema,
  dockerfile: relativePath,
  context: directory,
});

/**
 * What an artifact build produces, relative to the repository root: a single
 * jar file, or the directory of a static site (copied whole, `index.html`
 * included).
 */
export const artifactSchema = z.object({
  kind: z.enum(["jar", "static"]),
  path: relativePath,
});

export const buildSpecSchema = z
  .object({
    // Woodpecker branch filter. The branch also becomes part of the image tag,
    // so it has to pass the Panel's branch rule (no globs). Needs at least one
    // entry unless `artifact` is set (see the refinement below).
    branches: z.array(branchSchema),
    tagShaLength: z.number().int().min(7).max(40).default(7),
    images: z
      .array(buildImageSchema)
      .default([])
      .superRefine(unique((image) => image.name, "Duplicate image name")),
    // Files copied into the deploy bundle; `to` is relative to the deploy dir.
    bundleFiles: z
      .array(z.object({ from: relativePath, to: relativePath }))
      .default([])
      .superRefine(unique((file) => file.to, "Duplicate bundle target")),
    // Gate steps that run before the build, each in its own container.
    checks: z
      .array(
        z.object({
          name: stepName,
          image: imageReference,
          dir: directory,
          commands: z.array(z.string().trim().min(1)).min(1),
        })
      )
      .superRefine(unique((check) => check.name, "Duplicate check name"))
      .default([]),
    // A jar or static site built by the checks and pushed as the deploy image's
    // `/bundle/artifact/`. Replaces `images` and `bundleFiles`.
    artifact: artifactSchema.optional(),
    // Woodpecker repo timeout; applied to the repo settings, not the YAML.
    timeoutMinutes: z.number().int().min(10).max(180).default(60),
  })
  .superRefine((spec, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (spec.artifact) {
      // An artifact component registers before an engineer picks a branch.
      if (spec.images.length > 0) {
        issue("images", "An artifact build has no images");
      }
      if (spec.bundleFiles.length > 0) {
        issue("bundleFiles", "An artifact build has no bundle files");
      }
      if (spec.checks.length === 0) {
        issue("checks", "An artifact build needs a check that builds it");
      }
      return;
    }
    if (spec.branches.length === 0) issue("branches", "Needs a branch");
    if (spec.images.length === 0) issue("images", "Needs an image");
    if (spec.bundleFiles.length === 0)
      issue("bundleFiles", "Needs a bundle file");
  });

export type BuildSpec = z.infer<typeof buildSpecSchema>;
