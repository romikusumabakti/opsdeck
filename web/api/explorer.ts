import { queryOptions } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { ExplorerSource } from "@/lib/explorer";
import { api, orFailure, type PostJson } from "@/web/api/client";
import { REMOTE_PROBE } from "@/web/query-client";

const routes = api.api.explorer;
type Body<K extends keyof typeof routes> = PostJson<typeof routes, K>;

export async function listEntries(source: ExplorerSource, path?: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["list-entries"].$get({
          query: { q: JSON.stringify({ source, path }) },
        })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export const listEntriesQuery = (...args: Parameters<typeof listEntries>) =>
  queryOptions({
    queryKey: ["explorer", "listEntries", args],
    queryFn: () => listEntries(...args),
    ...REMOTE_PROBE,
  });

export async function getDownloadTarget(source: ExplorerSource, path?: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["get-download-target"].$get({
          query: { q: JSON.stringify({ source, path }) },
        })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export const getDownloadTargetQuery = (
  ...args: Parameters<typeof getDownloadTarget>
) =>
  queryOptions({
    queryKey: ["explorer", "getDownloadTarget", args],
    queryFn: () => getDownloadTarget(...args),
    ...REMOTE_PROBE,
  });

export async function readFileText(source: ExplorerSource, path?: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["read-file-text"].$get({
          query: { q: JSON.stringify({ source, path }) },
        })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export const readFileTextQuery = (...args: Parameters<typeof readFileText>) =>
  queryOptions({
    queryKey: ["explorer", "readFileText", args],
    queryFn: () => readFileText(...args),
    ...REMOTE_PROBE,
  });

export async function folderStats(source: ExplorerSource, path?: string) {
  return orFailure(
    () =>
      parseResponse(
        routes["folder-stats"].$get({
          query: { q: JSON.stringify({ source, path }) },
        })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export const folderStatsQuery = (...args: Parameters<typeof folderStats>) =>
  queryOptions({
    queryKey: ["explorer", "folderStats", args],
    queryFn: () => folderStats(...args),
    ...REMOTE_PROBE,
  });

export async function saveFileText(
  source: Body<"save-file-text">["source"],
  path: Body<"save-file-text">["path"],
  content: Body<"save-file-text">["content"],
  eol: Body<"save-file-text">["eol"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["save-file-text"].$post({ json: { source, path, content, eol } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function createFolder(
  source: Body<"create-folder">["source"],
  parentPath: Body<"create-folder">["parentPath"],
  name: Body<"create-folder">["name"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["create-folder"].$post({ json: { source, parentPath, name } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function deleteEntry(
  source: Body<"delete-entry">["source"],
  path: Body<"delete-entry">["path"]
) {
  return orFailure(
    () =>
      parseResponse(routes["delete-entry"].$post({ json: { source, path } })),
    (message) => ({ success: false, message }) as const
  );
}

export async function renameEntry(
  source: Body<"rename-entry">["source"],
  path: Body<"rename-entry">["path"],
  newName: Body<"rename-entry">["newName"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["rename-entry"].$post({ json: { source, path, newName } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function moveEntry(
  source: Body<"move-entry">["source"],
  path: Body<"move-entry">["path"],
  destDir: Body<"move-entry">["destDir"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["move-entry"].$post({ json: { source, path, destDir } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function copyEntry(
  source: Body<"copy-entry">["source"],
  path: Body<"copy-entry">["path"],
  destDir: Body<"copy-entry">["destDir"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["copy-entry"].$post({ json: { source, path, destDir } })
      ),
    (message) => ({ success: false, message }) as const
  );
}

export async function compressEntries(
  source: Body<"compress-entries">["source"],
  paths: Body<"compress-entries">["paths"],
  destDir: Body<"compress-entries">["destDir"],
  name: Body<"compress-entries">["name"]
) {
  return orFailure(
    () =>
      parseResponse(
        routes["compress-entries"].$post({
          json: { source, paths, destDir, name },
        })
      ),
    (message) => ({ success: false, message }) as const
  );
}
