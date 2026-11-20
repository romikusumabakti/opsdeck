import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SettingsRow = {
  brandName: string | null;
  brandCompany: string | null;
  brandAccent: string | null;
  brandUpdatedAt: Date | null;
};
type LogoRow = { theme: string; bytes: Uint8Array; contentType: string };

const state = vi.hoisted(() => ({
  role: "admin" as string,
  settings: {
    brandName: null,
    brandCompany: null,
    brandAccent: null,
    brandUpdatedAt: null,
  } as SettingsRow,
  logos: [] as LogoRow[],
}));

vi.mock("@/lib/auth-session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "user-1", role: state.role },
    session: { signInMethod: "passkey" },
  })),
}));

// A two-table stand-in for the database: instance_settings (one row) and
// instance_brand_logos (by theme). Select filters are ignored: the settings
// row is id 1 and every logo read takes all rows.
vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  const isLogos = (table: unknown) => table === schema.instanceBrandLogos;
  const selectFrom = (table: unknown) => {
    const rows = async () =>
      isLogos(table)
        ? state.logos.map((l) => ({
            theme: l.theme,
            type: l.contentType,
            bytes: l.bytes,
          }))
        : [
            {
              name: state.settings.brandName,
              company: state.settings.brandCompany,
              accent: state.settings.brandAccent,
              updatedAt: state.settings.brandUpdatedAt,
            },
          ];
    const query = {
      where: () => query,
      limit: () => query,
      // biome-ignore lint/suspicious/noThenProperty: a drizzle query is thenable.
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => void) =>
        rows().then(resolve, reject),
    };
    return query;
  };
  const db = {
    select: () => ({ from: selectFrom }),
    update: () => ({
      set: (values: Partial<SettingsRow>) => ({
        where: async () => {
          state.settings = { ...state.settings, ...values };
        },
      }),
    }),
    insert: () => ({
      values: (row: LogoRow) => ({
        onConflictDoUpdate: async () => {
          state.logos = [
            ...state.logos.filter((l) => l.theme !== row.theme),
            row,
          ];
        },
      }),
    }),
    delete: () => ({
      // eq(theme, value): the value is the chunk that holds a theme.
      where: async (condition: { queryChunks: { value?: unknown }[] }) => {
        const theme = condition.queryChunks.find(
          (chunk) => chunk?.value === "light" || chunk?.value === "dark"
        )?.value;
        state.logos = state.logos.filter((l) => l.theme !== theme);
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { db };
});

const activity = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: activity.record }));

const branding = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock("@/lib/instance-branding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instance-branding")>()),
  invalidateBranding: branding.invalidate,
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { app } = await import("@/server/app");

const BASE = "/api/instance/branding";
const ORIGIN = new URL(process.env.BETTER_AUTH_URL || "http://localhost")
  .origin;
const LOGO = readFileSync(join(__dirname, "fixtures/branding/logo.svg"));

function send(method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function upload(theme: string, bytes: Uint8Array | null, name = "logo.svg") {
  const form = new FormData();
  if (bytes) {
    form.append("file", new File([bytes as Uint8Array<ArrayBuffer>], name));
  }
  return app.request(`${BASE}/logo?theme=${theme}`, {
    method: "PUT",
    headers: { Origin: ORIGIN },
    body: form,
  });
}

// A 1×1 PNG, resized for raster uploads.
const SEED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

beforeEach(() => {
  state.role = "admin";
  state.settings = {
    brandName: null,
    brandCompany: null,
    brandAccent: null,
    brandUpdatedAt: null,
  };
  state.logos = [];
  activity.record.mockClear();
  branding.invalidate.mockClear();
});

describe("instance branding API", () => {
  it("403 for a non-admin on every branding route, before validation", async () => {
    for (const role of ["infra", "engineer", "staff"]) {
      state.role = role;
      const responses = [
        await send("GET", BASE),
        await send("PUT", BASE, { name: 42, accent: "teal" }),
        await upload("sideways", null),
        await send("DELETE", `${BASE}/logo?theme=sideways`),
      ];
      for (const res of responses) {
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: "forbidden" });
      }
    }
    expect(activity.record).not.toHaveBeenCalled();
  });

  it("saves name, company and accent; empty strings become null", async () => {
    const name = ["Acme", "Deck"].join(" ");
    const res = await send("PUT", BASE, {
      name: `  ${name}  `,
      company: "ACME Corp",
      accent: "blue",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name,
      company: "ACME Corp",
      accent: "blue",
      logo: null,
      logoDark: null,
    });
    expect(state.settings.brandUpdatedAt).toBeInstanceOf(Date);

    const cleared = await send("PUT", BASE, {
      name: "",
      company: "   ",
      accent: null,
    });
    expect(await cleared.json()).toMatchObject({
      name: null,
      company: null,
      accent: null,
    });
    expect(activity.record).toHaveBeenLastCalledWith({
      actorId: "user-1",
      action: "instance.brandingChanged",
      entityType: "instance",
      data: {
        nameChanged: "true",
        companyChanged: "true",
        accentChanged: "true",
        logoChanged: "false",
        logoDarkChanged: "false",
      },
    });
  });

  it("rejects an invalid body as 400", async () => {
    expect(
      (
        await send("PUT", BASE, {
          name: "x".repeat(61),
          company: null,
          accent: null,
        })
      ).status
    ).toBe(400);
    expect(
      (await send("PUT", BASE, { name: null, company: null, accent: "teal" }))
        .status
    ).toBe(400);
  });

  it("uploads a logo and records which fields changed, never the bytes", async () => {
    const res = await upload("light", LOGO);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logo).toMatchObject({ type: "image/svg+xml" });
    expect(body.logo.src).toMatch(/^\/brand\/logo\?v=[0-9a-z]+$/);
    expect(body.logoDark).toBeNull();
    expect(state.logos).toHaveLength(1);
    expect(state.logos[0]).toMatchObject({
      theme: "light",
      contentType: "image/svg+xml",
    });

    const call = activity.record.mock.calls.at(-1)?.[0];
    expect(call).toMatchObject({
      action: "instance.brandingChanged",
      entityType: "instance",
    });
    expect(call.data).toEqual({
      nameChanged: "false",
      companyChanged: "false",
      accentChanged: "false",
      logoChanged: "true",
      logoDarkChanged: "false",
    });
    const data = JSON.stringify(call.data);
    expect(data).not.toContain("svg");
    expect(data).not.toContain("base64");

    const dark = await upload("dark", LOGO);
    expect((await dark.json()).logoDark.src).toMatch(
      /^\/brand\/logo\?theme=dark&v=[0-9a-z]+$/
    );
    expect(activity.record.mock.calls.at(-1)?.[0].data).toMatchObject({
      logoChanged: "false",
      logoDarkChanged: "true",
    });

    const removed = await send("DELETE", `${BASE}/logo?theme=dark`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ logoDark: null });
    expect(state.logos.map((l) => l.theme)).toEqual(["light"]);
    expect(activity.record.mock.calls.at(-1)?.[0].data).toMatchObject({
      logoDarkChanged: "true",
    });
  });

  it("maps validation errors to 413, 415 and 422", async () => {
    const big = new Uint8Array(524_289);
    expect((await upload("light", big)).status).toBe(413);
    expect(await (await upload("light", big)).json()).toMatchObject({
      error: "too_large",
    });

    // A body far over the cap is refused before it is parsed.
    const huge = await upload("light", new Uint8Array(2 * 1024 * 1024));
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ error: "too_large" });

    // The same for a chunked body with no Content-Length.
    const form = new FormData();
    form.append("file", new File([new Uint8Array(2 * 1024 * 1024)], "x.png"));
    const encoded = new Response(form);
    const chunked = await app.request(`${BASE}/logo?theme=light`, {
      method: "PUT",
      headers: {
        Origin: ORIGIN,
        "Content-Type": String(encoded.headers.get("content-type")),
      },
      body: encoded.body,
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
    expect(await chunked.json()).toMatchObject({ error: "too_large" });

    const jpeg = await new Bun.Image(SEED).resize(128, 128).jpeg().bytes();
    const unsupported = await upload("light", jpeg, "logo.png");
    expect(unsupported.status).toBe(415);
    expect(await unsupported.json()).toMatchObject({
      error: "unsupported_type",
    });

    const wide = readFileSync(join(__dirname, "fixtures/branding/wide.svg"));
    const notSquare = await upload("light", wide);
    expect(notSquare.status).toBe(422);
    expect(await notSquare.json()).toMatchObject({ error: "not_square" });

    const small = await new Bun.Image(SEED).resize(32, 32).png().bytes();
    const tooSmall = await upload("light", small);
    expect(tooSmall.status).toBe(422);
    expect(await tooSmall.json()).toMatchObject({ error: "too_small" });

    const none = await upload("light", null);
    expect(none.status).toBe(400);
    expect(await none.json()).toMatchObject({ error: "no_file" });

    expect((await upload("sideways", LOGO)).status).toBe(400);
    expect(state.logos).toEqual([]);
    expect(activity.record).not.toHaveBeenCalled();
    expect(branding.invalidate).not.toHaveBeenCalled();
  });

  it("removing a logo that is not there writes nothing", async () => {
    const res = await send("DELETE", `${BASE}/logo?theme=dark`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ logoDark: null });
    expect(state.settings.brandUpdatedAt).toBeNull();
    expect(activity.record).not.toHaveBeenCalled();
    expect(branding.invalidate).not.toHaveBeenCalled();
  });

  it("invalidates the branding cache on save", async () => {
    await send("PUT", BASE, { name: null, company: null, accent: "green" });
    expect(branding.invalidate).toHaveBeenCalledTimes(1);
    await upload("light", LOGO);
    expect(branding.invalidate).toHaveBeenCalledTimes(2);
    await send("DELETE", `${BASE}/logo?theme=light`);
    expect(branding.invalidate).toHaveBeenCalledTimes(3);
  });
});
