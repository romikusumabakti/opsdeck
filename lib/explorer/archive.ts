import "server-only";

import type { Readable } from "node:stream";
import { ZipFile } from "yazl";
import type { Tree } from "./ops";
import type { StorageBackend } from "./types";

// Turning a collected tree into ZIP bytes. Shared by the download route (which
// streams the result to the browser) and the compress action (which streams it
// back into the storage backend), so the two can never drift on how an archive
// is laid out.
//
// Nothing is buffered: addReadStreamLazy opens each file only when the archive
// reaches that entry, so exactly one backend read stream is live at a time
// (critical over SFTP, where each stream is its own SSH connection) and the
// consumer's backpressure reaches all the way down to the source.

// Above this, ZIP needs the zip64 record layout. Sizes come from the listing,
// which can be stale, so the flag is set generously — zip64 for an entry that
// turns out smaller is still a valid archive.
const ZIP64_THRESHOLD = 0xff_ff_ff_ff;

export function zipStream(backend: StorageBackend, tree: Tree): Readable {
  const zip = new ZipFile();
  // A read failure surfaces once the archive is already flowing, when there is
  // no status code left to send. Destroying the output stream aborts the
  // transfer — the consumer sees a failure instead of a truncated archive.
  zip.on("error", (error) => {
    console.error("Explorer archive failed:", error);
    (zip.outputStream as Readable).destroy(error as Error);
  });
  for (const emptyDir of tree.emptyDirs) {
    zip.addEmptyDirectory(emptyDir);
  }
  for (const file of tree.files) {
    zip.addReadStreamLazy(
      file.relPath,
      {
        ...(file.modifiedAt ? { mtime: file.modifiedAt } : {}),
        forceZip64Format: (file.sizeBytes ?? 0) >= ZIP64_THRESHOLD,
      },
      (cb) => {
        backend.readStream(file.path).then(
          (stream) => cb(null, stream),
          (error) => cb(error, null as never)
        );
      }
    );
  }
  // Entries are already queued; end() only writes the central directory once
  // the last one has been pumped.
  zip.end();
  return zip.outputStream as Readable;
}
