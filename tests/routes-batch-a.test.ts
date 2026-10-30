import { describe, expect, it } from "vitest";
import { z } from "zod";
import { app, createBaseApp } from "@/server/app";
import { jsonQuery } from "@/server/validation";

// No cookie on any request here: better-auth answers get-session with null
// without touching the database, so every gated route must stop at its session
// check. A route that reached Postgres first would fail on the dummy
// DATABASE_URL (500) instead of answering 401 — that would be a guard-order bug.

const ID = "0190a8e2-7b1c-7cc2-9d3e-3c1f2a4b5c6d";

function post(path: string, body: unknown = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// One read and one write per mounted module (activity has no write).
const GATED: [method: "GET" | "POST", path: string][] = [
  ["GET", "/api/issues/get-open-issue-counts"],
  ["POST", "/api/issues/create-issue"],
  ["GET", `/api/issue-attachments/list-issue-attachments?issueId=${ID}`],
  ["POST", "/api/issue-attachments/delete-issue-attachment"],
  ["GET", "/api/labels/list-labels"],
  ["POST", "/api/labels/set-issue-labels"],
  ["GET", `/api/milestones/list-milestones?projectId=${ID}`],
  ["POST", "/api/milestones/create-milestone"],
  ["GET", "/api/saved-views/list-saved-views"],
  ["POST", "/api/saved-views/create-saved-view"],
  ["GET", "/api/notifications/list-notifications"],
  ["POST", "/api/notifications/mark-all-notifications-read"],
  ["GET", "/api/home/attention-groups"],
  ["POST", "/api/home/acknowledge-attention-group"],
  ["GET", "/api/activity/list-activity"],
  ["GET", "/api/knowledge/collections"],
  ["POST", "/api/knowledge/create-collection"],
  ["GET", "/api/users/list-users"],
  ["POST", "/api/users/invite-user"],
  ["GET", "/api/profile/account"],
  ["POST", "/api/profile/update-profile"],
  ["GET", "/api/access/get-access-matrix"],
  ["POST", "/api/access/offboard-user"],
  ["GET", `/api/project-members/list-project-members?projectId=${ID}`],
  ["POST", "/api/project-members/add-project-member"],
  ["GET", "/api/project-catalog/list-projects"],
  ["POST", "/api/project-catalog/add-project"],
  // Handlers ported from app/api keep their paths.
  ["GET", `/api/issues/attachments/${ID}`],
  ["POST", `/api/issues/${ID}/attachments`],
  ["GET", `/api/knowledge/asset/${ID}`],
  ["POST", "/api/knowledge/asset"],
  ["GET", `/api/users/${ID}/card`],
  ["POST", "/api/avatars"],
  ["POST", "/api/avatars/microsoft"],
  ["GET", `/api/avatars/${ID}/abc`],
];

describe("gated routes answer 401 without a session", () => {
  it.each(GATED)("%s %s", async (method, path) => {
    const res = method === "GET" ? await app.request(path) : await post(path);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("DELETE /api/avatars", async () => {
    // Bodyless, so the CSRF check applies; a browser marks its own fetch.
    const res = await app.request("/api/avatars", {
      method: "DELETE",
      headers: { "Sec-Fetch-Site": "same-origin" },
    });
    expect(res.status).toBe(401);
  });

  // The session check runs before body validation, so a signed-out caller
  // learns nothing about the expected payload.
  it("checks the session before validating the body", async () => {
    const res = await post("/api/issues/create-issue", { data: 42 });
    expect(res.status).toBe(401);
  });
});

describe("public routes", () => {
  it("GET /api/bootstrap returns the branding without a session", async () => {
    const res = await app.request("/api/bootstrap");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      "allowedEmailDomain",
      "appName",
      "appTimeZone",
      "brand",
      "companyName",
      "microsoftSignIn",
    ]);
    expect(typeof body.microsoftSignIn).toBe("boolean");
    expect(typeof body.appTimeZone).toBe("string");
  });

  it("GET /api/me returns null without a session", async () => {
    const res = await app.request("/api/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  // Onboarding runs before the caller has an account: it must not sit behind
  // the session check. An invalid body fails validation (400), not auth.
  it.each([
    "/api/onboarding/accept-invitation",
    "/api/onboarding/create-initial-user",
  ])("POST %s is public and validates its body", async (path) => {
    const res = await post(path, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });
});

describe("jsonQuery", () => {
  const probe = createBaseApp().get(
    "/probe",
    jsonQuery(z.object({ ids: z.array(z.uuid()), n: z.number().optional() })),
    (c) => c.json(c.req.valid("query"))
  );
  const q = (value: string) => `/probe?q=${encodeURIComponent(value)}`;

  it("parses and validates the q parameter", async () => {
    const res = await probe.request(q(JSON.stringify({ ids: [ID], n: 2 })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ids: [ID], n: 2 });
  });

  it.each([
    ["malformed JSON", q("{ids:")],
    ["a schema mismatch", q(JSON.stringify({ ids: ["nope"] }))],
    ["a missing q", "/probe"],
  ])("rejects %s with 400", async (_label, path) => {
    const res = await probe.request(path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request" });
  });
});
