import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The instance name, company and accent are read from the stored branding at
// runtime: a save shows in the bootstrap, the shell, the server translator and
// the emails without a restart, and another process's save within the TTL.

type SettingsRow = {
  brandName: string | null;
  brandCompany: string | null;
  brandAccent: string | null;
  brandUpdatedAt: Date | null;
};
type LogoRow = { theme: string; bytes: Uint8Array; contentType: string };

const state = vi.hoisted(() => ({
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
    user: { id: "user-1", role: "admin" },
    session: { signInMethod: "passkey" },
  })),
  getServerSession: vi.fn(async () => null),
}));

// The same two-table stand-in as tests/branding-api.test.ts.
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
      values: () => ({ onConflictDoUpdate: async () => {} }),
    }),
    delete: () => ({ where: async () => {} }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return { db };
});

vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: mail.send };
  },
}));

process.env.SECRETS_KEY ??= Buffer.alloc(32, 7).toString("base64");
const { app } = await import("@/server/app");
const { mountStatic } = await import("@/server/static");
const { invalidateBranding } = await import("@/lib/instance-branding");
const { getServerTranslator } = await import("@/server/i18n");
const { sendInvitationEmail } = await import("@/lib/email/send");

const ORIGIN = new URL(process.env.BETTER_AUTH_URL || "http://localhost")
  .origin;
const NAME = ["Acme", "Ops"].join(" ");
const INDEX_HTML =
  '<!doctype html><html lang="en"><head><link rel="icon" href="/brand/icon.svg" type="image/svg+xml" /><title>Menara</title></head><div id="root"></div></html>';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "menara-runtime-branding-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "index.html"), INDEX_HTML);
  vi.stubEnv("NODE_ENV", "production");
  try {
    mountStatic(app, { clientDir: dir, publicDir: join(dir, "public") });
  } finally {
    vi.unstubAllEnvs();
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  state.settings = {
    brandName: null,
    brandCompany: null,
    brandAccent: null,
    brandUpdatedAt: null,
  };
  state.logos = [];
  mail.send.mockReset();
  mail.send.mockResolvedValue({ error: null });
  invalidateBranding();
});

afterEach(() => {
  vi.useRealTimers();
});

// The admin's save: PUT takes every field, so the rest are cleared.
async function saveBranding(body: Record<string, unknown>) {
  const res = await app.request("/api/instance/branding", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ name: null, company: null, accent: null, ...body }),
  });
  expect(res.status).toBe(200);
}

async function bootstrap() {
  const res = await app.request("/api/bootstrap");
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function shell() {
  const res = await app.request("/en/servers");
  expect(res.status).toBe(200);
  return res.text();
}

describe("runtime instance branding", () => {
  it("bootstrap reflects a saved name without a restart", async () => {
    expect((await bootstrap()).appName).toBe("Menara");
    await saveBranding({ name: NAME });
    const res = await app.request("/api/bootstrap");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.json();
    expect(body).toMatchObject({
      appName: NAME,
      companyName: null,
      accent: "neutral",
      logo: null,
      icon: { src: "/brand/icon.svg", type: "image/svg+xml", custom: false },
    });
    expect(body).not.toHaveProperty("brand");
  });

  it("the shell <title> and data-accent follow the saved branding", async () => {
    expect(await shell()).toContain("<title>Menara</title>");
    await saveBranding({ name: NAME, accent: "blue" });
    const html = await shell();
    expect(html).toContain(`<title>${NAME}</title>`);
    expect(html).toContain('data-accent="blue"');
    expect(html).not.toContain("data-brand");
    expect(html).toContain(
      '<link rel="icon" href="/brand/icon.svg" type="image/svg+xml" />'
    );
  });

  it("the shell links a raster logo's PNG favicon", async () => {
    state.settings.brandUpdatedAt = new Date(1_700_000_000_000);
    state.logos = [
      { theme: "light", bytes: new Uint8Array(), contentType: "image/png" },
    ];
    invalidateBranding();
    const version = (1_700_000_000_000).toString(36);
    const html = await shell();
    expect(html).toMatch(
      new RegExp(
        `<link rel="icon" href="/brand/icon\\.png\\?v=${version}" type="image/png"`
      )
    );
    expect(await bootstrap()).toMatchObject({
      logo: { src: `/brand/logo?v=${version}`, darkSrc: null },
      icon: {
        src: `/brand/icon.png?v=${version}`,
        type: "image/png",
        custom: true,
      },
    });
  });

  it("an SVG logo is the favicon, versioned", async () => {
    state.settings.brandUpdatedAt = new Date(1_700_000_000_000);
    state.logos = [
      { theme: "light", bytes: new Uint8Array(), contentType: "image/svg+xml" },
      { theme: "dark", bytes: new Uint8Array(), contentType: "image/png" },
    ];
    invalidateBranding();
    const version = (1_700_000_000_000).toString(36);
    expect(await bootstrap()).toMatchObject({
      logo: {
        src: `/brand/logo?v=${version}`,
        darkSrc: `/brand/logo?theme=dark&v=${version}`,
      },
      icon: {
        src: `/brand/icon.svg?v=${version}`,
        type: "image/svg+xml",
        custom: true,
      },
    });
  });

  it("the server translator interpolates the saved name", async () => {
    expect((await getServerTranslator())("app.name")).toBe("Menara");
    await saveBranding({ name: NAME });
    expect((await getServerTranslator())("app.name")).toBe(NAME);
  });

  it("the invitation subject and template use the saved name", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("EMAIL_FROM", undefined);
    try {
      await saveBranding({ name: NAME });
      await sendInvitationEmail("ana@example.com", {
        recipientName: "Ana",
        inviteUrl: "https://example.com/invite",
        expiresInHours: 24,
      });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(mail.send).toHaveBeenCalledTimes(1);
    const message = mail.send.mock.calls[0]?.[0];
    expect(message.subject).toBe(`Undangan ke ${NAME}`);
    expect(message.html).toContain(NAME);
    expect(message.from).toContain(NAME);
  });

  it("another process's save is seen after the TTL", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    expect((await bootstrap()).appName).toBe("Menara");
    // Written by another process: nothing here invalidates the cache.
    state.settings.brandName = NAME;
    vi.advanceTimersByTime(29_000);
    expect((await bootstrap()).appName).toBe("Menara");
    vi.advanceTimersByTime(1_000);
    expect((await bootstrap()).appName).toBe(NAME);
  });

  it("escapes the name in the title", async () => {
    await saveBranding({ name: '</title><script>alert("x")</script>&' });
    expect(await shell()).toContain(
      "<title>&lt;/title&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;</title>"
    );
    // `$` sequences are text, never replacement patterns that copy the shell.
    const name = "Ops $& $' $` $1 $<x> $$ x";
    await saveBranding({ name });
    const html = await shell();
    expect(html).toBe(
      INDEX_HTML.replace("<html", '<html data-accent="neutral"').replace(
        "<title>Menara</title>",
        () => "<title>Ops $&amp; $&#39; $` $1 $&lt;x&gt; $$ x</title>"
      )
    );
  });
});
