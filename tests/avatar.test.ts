import { beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import {
  AVATAR_SIZES,
  avatarKey,
  avatarSrc,
  avatarUrl,
  hashFromAvatarUrl,
  snapAvatarSize,
} from "@/lib/avatar-url";
import { sniffImage } from "@/lib/image-sniff";

const UID = "0199a1b2-0000-7000-8000-000000000001";

describe("snapAvatarSize", () => {
  it.each([
    [null, 64],
    ["", 64],
    ["abc", 64],
    ["-5", 64],
    ["1", 24],
    ["24", 24],
    ["25", 32],
    ["64", 64],
    ["65", 96],
    ["9999", 256],
    [80, 96],
  ])("%p -> %p", (raw, expected) => {
    expect(snapAvatarSize(raw as string | number | null)).toBe(expected);
  });
  it("only yields allowed sizes", () => {
    for (let i = 0; i < 600; i += 7)
      expect(AVATAR_SIZES).toContain(snapAvatarSize(i));
  });
});

describe("avatar urls", () => {
  it("round-trips the hash", () => {
    const url = avatarUrl(UID, "0123456789abcdef");
    expect(url).toBe(`/api/avatars/${UID}/0123456789abcdef`);
    expect(hashFromAvatarUrl(url)).toBe("0123456789abcdef");
    expect(avatarKey(UID, "0123456789abcdef")).toBe(
      `avatars/${UID}/0123456789abcdef`
    );
  });
  it("ignores foreign urls", () => {
    expect(hashFromAvatarUrl("https://graph.microsoft.com/x")).toBeNull();
    expect(hashFromAvatarUrl(null)).toBeNull();
  });
  it("builds a sized src", () => {
    expect(avatarSrc(avatarUrl(UID, "0123456789abcdef"), 30)).toBe(
      `/api/avatars/${UID}/0123456789abcdef?s=32`
    );
  });
});

describe("sniffImage", () => {
  const pad = (b: number[]) => Buffer.from([...b, ...new Array(16).fill(0)]);
  it("detects png/jpeg/webp/avif/gif", () => {
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47]))?.mime).toBe("image/png");
    expect(sniffImage(pad([0xff, 0xd8, 0xff]))?.mime).toBe("image/jpeg");
    expect(
      sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))?.mime
    ).toBe("image/webp");
    expect(
      sniffImage(Buffer.from("\0\0\0\x1cftypavif\0\0\0\0", "latin1"))?.mime
    ).toBe("image/avif");
    expect(sniffImage(Buffer.from("GIF89a\0\0\0\0\0\0", "latin1"))?.mime).toBe(
      "image/gif"
    );
  });
  it("rejects svg and short buffers", () => {
    expect(
      sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    ).toBeNull();
    expect(sniffImage(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe("imgproxyUrl fill", () => {
  beforeAll(() => {
    process.env.IMGPROXY_URL = "http://imgproxy:8080";
    process.env.IMGPROXY_KEY = "aa".repeat(32);
    process.env.IMGPROXY_SALT = "bb".repeat(32);
    process.env.S3_BUCKET = "knowledge";
  });
  it("signs an rs:fill path", async () => {
    const { imgproxyUrl } = await import("@/lib/imgproxy");
    const url = imgproxyUrl(`avatars/${UID}/0123456789abcdef`, {
      width: 64,
      fill: true,
    });
    const [, signature, ...rest] = new URL(url).pathname.split("/");
    const path = `/${rest.join("/")}`;
    expect(path.startsWith("/rs:fill:64:64:1/g:ce/q:82/")).toBe(true);
    const expected = createHmac(
      "sha256",
      Buffer.from(process.env.IMGPROXY_KEY!, "hex")
    )
      .update(Buffer.from(process.env.IMGPROXY_SALT!, "hex"))
      .update(path)
      .digest("base64url");
    expect(signature).toBe(expected);
  });
  it("keeps the fit default", async () => {
    const { imgproxyUrl } = await import("@/lib/imgproxy");
    expect(imgproxyUrl("kb/x.png")).toContain("/rs:fit:1600:0/q:82/");
  });
});
