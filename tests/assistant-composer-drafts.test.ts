import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  composerDrafts,
  EMPTY_DRAFT,
  type UploadMessages,
} from "@/web/components/assistant/composer-drafts";

const api = vi.hoisted(() => ({ uploadFile: vi.fn(), deleteUpload: vi.fn() }));
vi.mock("@/web/api/assistant", () => api);

const messages: UploadMessages = {
  tooMany: "too many",
  unsupported: "unsupported",
  tooLarge: (mb) => `too large ${mb}`,
  failed: () => "failed",
};

function deferred() {
  let resolve!: (v: { id: string }) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<{ id: string }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const pdf = (name = "a.pdf") =>
  new File(["x"], name, { type: "application/pdf" });
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  composerDrafts.resetForTests();
  api.uploadFile.mockReset();
  api.deleteUpload.mockReset().mockResolvedValue(undefined);
  composerDrafts.forUser("u1");
});

describe("composerDrafts", () => {
  it("keeps a draft per key", () => {
    composerDrafts.update("c1", (d) => ({ ...d, text: "one" }));
    composerDrafts.update("new", (d) => ({ ...d, text: "two" }));
    expect(composerDrafts.get("c1").text).toBe("one");
    expect(composerDrafts.get("new").text).toBe("two");
    expect(composerDrafts.get("c9")).toBe(EMPTY_DRAFT);
  });

  it("an upload finishes into the draft it was added to", async () => {
    const d = deferred();
    api.uploadFile.mockReturnValue(d.promise);
    composerDrafts.addFiles("c1", [pdf()], messages);
    expect(composerDrafts.get("c1").files[0]?.status).toBe("uploading");
    expect(composerDrafts.get("c2").files).toEqual([]);
    d.resolve({ id: "up1" });
    await flush();
    expect(composerDrafts.get("c1").files[0]).toMatchObject({
      status: "ready",
      id: "up1",
    });
    expect(composerDrafts.get("c2").files).toEqual([]);
  });

  it("clear keeps uploads on the server; drop deletes them", async () => {
    const pending = deferred();
    api.uploadFile.mockResolvedValueOnce({ id: "up1" });
    composerDrafts.addFiles("c1", [pdf()], messages);
    await flush();
    composerDrafts.clear("c1");
    expect(api.deleteUpload).not.toHaveBeenCalled();
    expect(composerDrafts.get("c1")).toBe(EMPTY_DRAFT);

    let signal!: AbortSignal;
    api.uploadFile
      .mockResolvedValueOnce({ id: "up2" })
      .mockImplementationOnce((_file: File, opts: { signal: AbortSignal }) => {
        signal = opts.signal;
        return pending.promise;
      });
    composerDrafts.addFiles("c1", [pdf("b.pdf"), pdf("c.pdf")], messages);
    await flush();
    composerDrafts.drop("c1");
    expect(api.deleteUpload).toHaveBeenCalledWith("up2");
    expect(signal.aborted).toBe(true);
    expect(composerDrafts.get("c1")).toBe(EMPTY_DRAFT);
  });

  it("drafts are per user", () => {
    const d = deferred();
    let signal!: AbortSignal;
    api.uploadFile.mockImplementation(
      (_file: File, opts: { signal: AbortSignal }) => {
        signal = opts.signal;
        return d.promise;
      }
    );
    composerDrafts.update("new", (x) => ({ ...x, text: "secret" }));
    composerDrafts.addFiles("new", [pdf()], messages);
    composerDrafts.forUser("u1");
    expect(composerDrafts.get("new").text).toBe("secret");
    expect(composerDrafts.read("u2", "new")).toBe(EMPTY_DRAFT);
    composerDrafts.forUser("u2");
    expect(composerDrafts.get("new")).toBe(EMPTY_DRAFT);
    expect(signal.aborted).toBe(true);
  });

  it("refuses unsupported and oversized files with a chip reason", () => {
    api.uploadFile.mockReturnValue(deferred().promise);
    composerDrafts.addFiles("new", [new File(["x"], "a.exe"), pdf()], messages);
    const [bad] = composerDrafts.get("new").files;
    expect(bad).toMatchObject({ status: "failed", error: "unsupported" });
    expect(api.uploadFile).toHaveBeenCalledTimes(1);
    const big = pdf("big.pdf");
    Object.defineProperty(big, "size", { value: 10 ** 10 });
    composerDrafts.addFiles("new", [big], messages);
    expect(composerDrafts.get("new").files.at(-1)?.error).toMatch(/^too large/);
  });

  it("sets the notice past the 10-file limit and removing clears it", async () => {
    api.uploadFile.mockResolvedValue({ id: "x" });
    const many = Array.from({ length: 12 }, (_, i) => pdf(`f${i}.pdf`));
    composerDrafts.addFiles("new", many, messages);
    expect(composerDrafts.get("new").files).toHaveLength(10);
    expect(composerDrafts.get("new").notice).toBe("too many");
    await flush();
    const first = composerDrafts.get("new").files[0];
    composerDrafts.removeFile("new", first?.key ?? "");
    expect(api.deleteUpload).toHaveBeenCalledWith("x");
    expect(composerDrafts.get("new").notice).toBeNull();
    expect(composerDrafts.get("new").files).toHaveLength(9);
  });
});
