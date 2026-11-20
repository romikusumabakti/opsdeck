// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDocumentAccent,
  applyDocumentLocale,
} from "@/web/document-locale";

afterEach(() => {
  document.documentElement.removeAttribute("lang");
  document.documentElement.removeAttribute("dir");
  document.documentElement.removeAttribute("data-accent");
  document.head.innerHTML = "";
});

describe("applyDocumentLocale", () => {
  it("sets lang and the text direction on <html>", () => {
    applyDocumentLocale("ar");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");

    applyDocumentLocale("en");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
  });
});

describe("applyDocumentAccent", () => {
  it("sets data-accent and points the favicon at the accent's icon", () => {
    document.head.innerHTML =
      '<link rel="icon" type="image/svg+xml" href="/brand/icon.svg" />';

    applyDocumentAccent("rose", {
      src: "/brand/icon.svg",
      type: "image/svg+xml",
      custom: false,
    });

    expect(document.documentElement.dataset.accent).toBe("rose");
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(icon?.getAttribute("href")).toBe("/brand/icon.svg?accent=rose");
    expect(icon?.getAttribute("type")).toBe("image/svg+xml");
  });

  it("points the favicon at a raster logo's PNG, untinted", () => {
    document.head.innerHTML =
      '<link rel="icon" type="image/svg+xml" href="/brand/icon.svg" />';

    applyDocumentAccent("rose", {
      src: "/brand/icon.png?v=kx1",
      type: "image/png",
      custom: true,
    });

    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    expect(icon?.getAttribute("href")).toBe("/brand/icon.png?v=kx1");
    expect(icon?.getAttribute("type")).toBe("image/png");
  });
});
