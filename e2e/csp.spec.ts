import { expect, type Page, test } from "@playwright/test";
import { AUTH_FILE } from "./support";

test.use({ storageState: AUTH_FILE });

declare global {
  interface Window {
    __csp: string[];
    __darkBeforeRender?: boolean;
  }
}

// The Content-Security-Policy locks scripts to the app's own origin, so a page
// that still needs an inline script, eval or a foreign script would break only
// in the browser. Browsers report that as a `securitypolicyviolation` event
// and a console error; every page here must produce neither.
async function watchViolations(page: Page) {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      message.text().includes("Content Security Policy")
    ) {
      consoleErrors.push(message.text());
    }
  });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__csp.push(
        `${event.violatedDirective} blocked ${event.blockedURI || "inline"} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber} ${event.sample}`
      );
    });
    // Record whether the dark class lands before React renders anything.
    const observer = new MutationObserver(() => {
      if (document.documentElement.classList.contains("dark")) {
        window.__darkBeforeRender ??=
          (document.getElementById("root")?.childElementCount ?? 0) === 0;
        observer.disconnect();
      }
    });
    observer.observe(document, { attributes: true, subtree: true });
  });
  return consoleErrors;
}

async function violations(page: Page) {
  return page.evaluate(() => window.__csp);
}

async function post<T>(page: Page, path: string, data: unknown): Promise<T> {
  const res = await page.request.post(path, { data: { data } });
  expect(res.ok(), `${path}: ${res.status()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

test("the policy header is on the shell and the theme script is an external file", async ({
  page,
}) => {
  const shell = await page.request.get("/en");
  expect(shell.headers()["content-security-policy"]).toContain(
    "script-src 'self' 'wasm-unsafe-eval'"
  );
  expect(await shell.text()).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  const theme = await page.request.get("/theme-init.js");
  expect(theme.status()).toBe(200);
});

test("the saved theme is applied before the app renders, without a violation", async ({
  page,
}) => {
  const consoleErrors = await watchViolations(page);
  await page.addInitScript(() => localStorage.setItem("theme", "dark"));
  await page.goto("/en");
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => window.__darkBeforeRender)).toBe(true);
  expect(await violations(page)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("pages that load app scripts, the editor and WebAssembly raise no violations", async ({
  page,
}) => {
  const key = "CSPX";
  const consoleErrors = await watchViolations(page);

  const project = await post<{ id: string }>(
    page,
    "/api/project-catalog/add-project",
    { name: "E2E CSP", key }
  );
  const server = await post<{ id: string }>(
    page,
    "/api/servers/create-server",
    {
      name: "E2E CSP server",
      host: "192.0.2.10",
      username: "ops",
      password: "secret",
    }
  );
  const env = await post<{ slug: string }>(
    page,
    "/api/environments/create-environment",
    {
      projectId: project.id,
      name: "Staging",
      host: "192.0.2.10:8080",
      url: "https://app.example.com/login",
      dbServerId: server.id,
      dbServiceType: "docker",
      dbServiceName: "db",
      dbType: "postgres",
      dbName: "app",
      dbBackupPath: "/backups",
      backendServerId: server.id,
      backendServiceType: "docker",
      backendServiceName: "api",
      frontendServerId: server.id,
      frontendServiceType: "docker",
      frontendServiceName: "web",
    }
  );
  const collection = await post<{ id: string }>(
    page,
    "/api/knowledge/create-collection",
    { name: "E2E CSP" }
  );
  const doc = await post<{ slug: string }>(
    page,
    "/api/knowledge/create-document",
    { collectionId: collection.id, title: "CSP page", content: "# Hello" }
  );

  const pages = [
    "/en",
    `/en/knowledge/${doc.slug}`,
    `/en/knowledge/${doc.slug}/edit`,
    `/en/${key}/${env.slug}/mock-time`,
    `/en/servers/${server.id}/terminal`,
    `/en/servers/${server.id}/files`,
  ];
  for (const path of pages) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#root")).not.toBeEmpty();
    expect(await violations(page), path).toEqual([]);
  }
  expect(consoleErrors).toEqual([]);
});
