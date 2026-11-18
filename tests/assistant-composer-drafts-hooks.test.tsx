// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composerDrafts,
  useComposerDraft,
  useDraftUser,
} from "@/web/components/assistant/composer-drafts";
import { ME_QUERY_KEY } from "@/web/query-client";

vi.mock("@/web/api/assistant", () => ({
  uploadFile: vi.fn(),
  deleteUpload: vi.fn(),
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
const renders = { a: 0, b: 0 };

function Box({ id, draftKey }: { id: "a" | "b"; draftKey: string }) {
  const userId = useDraftUser();
  const [draft] = useComposerDraft(userId, draftKey);
  renders[id] += 1;
  return <p data-box={id}>{draft.text}</p>;
}

const text = (id: string) =>
  container.querySelector(`[data-box=${id}]`)?.textContent;

const setUser = (id: string) =>
  act(async () => {
    client.setQueryData(ME_QUERY_KEY, { user: { id }, orgRole: "member" });
    await new Promise((r) => setTimeout(r, 10));
  });

beforeEach(async () => {
  composerDrafts.resetForTests();
  renders.a = 0;
  renders.b = 0;
  client = new QueryClient();
  client.setQueryData(ME_QUERY_KEY, { user: { id: "u1" }, orgRole: "member" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Box id="a" draftKey="c1" />
        <Box id="b" draftKey="c2" />
      </QueryClientProvider>
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useComposerDraft", () => {
  it("re-renders only the component whose key changed", async () => {
    const before = { ...renders };
    await act(async () => {
      composerDrafts.update("c1", (d) => ({ ...d, text: "hello" }));
    });
    expect(text("a")).toBe("hello");
    expect(text("b")).toBe("");
    expect(renders.a).toBeGreaterThan(before.a);
    expect(renders.b).toBe(before.b);
  });

  it("shows empty drafts after another user signs in", async () => {
    await act(async () => {
      composerDrafts.update("c1", (d) => ({ ...d, text: "secret" }));
    });
    expect(text("a")).toBe("secret");
    await setUser("u2");
    expect(text("a")).toBe("");
    expect(composerDrafts.get("c1").text).toBe("");
  });
});
