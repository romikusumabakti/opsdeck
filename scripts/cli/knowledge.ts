// `menara knowledge import`: the arguments and usage. The import itself
// (scripts/cli/knowledge-import.ts) loads the knowledge services and with them
// auth and the database, so it is imported only once the arguments are valid.

export const KNOWLEDGE_USAGE = `Usage: menara knowledge import <folder> --as <email> [--dry-run] [--update-visibility]
  (in the image: bun dist/cli.js knowledge import …)

<folder> is read where the CLI runs: in production, copy it into the app
container first, then import it (and again without --dry-run):

  docker compose -f /opt/<name>/compose.yaml cp ./guides app:/tmp/kb
  docker compose -f /opt/<name>/compose.yaml exec app menara knowledge import /tmp/kb --as you@example.com --dry-run

Imports every *.md file directly in <folder> (not subfolders) as a published
knowledge document, written as the --as user, who must hold knowledge:manage.
Each file starts with YAML front matter:

  ---
  collection: Team Guides     # collection name; created when missing
  title: Deploy Flow
  slug: deploy-flow           # recommended: the document's identity across runs
  docType: runbook            # optional: doc (default), runbook, spec, requirement
  visibleTo: [infra]          # optional: roles that see the collection; [] = everyone
  ---

A document is matched by its slug. Without a slug the title's is used (with a
warning), so a changed title then imports as a new document. A new one is appended at the end of its
collection, an existing one is updated with a revision when its title, type or
body changed and left alone otherwise. Links to other files of the folder,
[text](other.md) or (other.md#section), become /knowledge/<slug> links.
The whole folder is checked first (unknown roles, missing titles, duplicate
slugs, a slug held in another collection, files disagreeing on a collection's
visibleTo, an existing collection whose visibility differs without
--update-visibility, files over 1 MB); any problem stops the run before
anything is written. Symlinks and other non-regular files are skipped.

--dry-run            Print what would happen; write nothing.
--update-visibility  Apply the files' visibleTo to an existing collection that
                     has a different one (refused otherwise).`;

export interface ImportArgs {
  folder: string;
  asEmail: string;
  dryRun: boolean;
  updateVisibility: boolean;
}

/** `import <folder> --as <email> [flags]`, or null when malformed. */
export function parseImportArgs(args: string[]): ImportArgs | null {
  const [sub, ...rest] = args;
  if (sub !== "import") return null;
  let folder: string | undefined;
  let asEmail: string | undefined;
  let dryRun = false;
  let updateVisibility = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === "--as") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) return null;
      asEmail = value;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--update-visibility") {
      updateVisibility = true;
    } else if (arg.startsWith("--") || folder !== undefined) {
      return null;
    } else {
      folder = arg;
    }
  }
  if (folder === undefined || asEmail === undefined) return null;
  return { folder, asEmail, dryRun, updateVisibility };
}

export async function runKnowledge(args: string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(KNOWLEDGE_USAGE);
    return 0;
  }
  const parsed = parseImportArgs(args);
  if (!parsed) {
    console.error(KNOWLEDGE_USAGE);
    return 1;
  }
  const [{ importKnowledge }, { pgClient }] = await Promise.all([
    import("./knowledge-import"),
    import("@/lib/db"),
  ]);
  try {
    return await importKnowledge({
      ...parsed,
      out: console.log,
      err: console.error,
    });
  } finally {
    await pgClient().end();
  }
}
