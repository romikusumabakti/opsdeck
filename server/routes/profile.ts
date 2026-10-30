import { z } from "zod";
import { accentSchema } from "@/lib/accents";
import { recordActivity } from "@/lib/activity";
import { requireSession } from "@/lib/auth-session";
import { AVATAR_HASH_RE, avatarKey, snapAvatarSize } from "@/lib/avatar-url";
import { removeAvatar, storeAvatar } from "@/lib/avatars";
import { importMicrosoftAvatar } from "@/lib/avatars-microsoft";
import { db } from "@/lib/db";
import { imgproxyUrl } from "@/lib/imgproxy";
import { motifPreferenceSchema } from "@/lib/motifs";
import {
  AVATAR_MAX_BYTES,
  profileInputSchema,
  statusInputSchema,
  timeZoneSchema,
  uuidSchema,
} from "@/lib/validation";
import { sessionRouter } from "@/server/router";
import {
  adminRemoveAvatar,
  adminUpdateProfile,
  clearStatus,
  setAccentColor,
  setMotif,
  setMyTimeZone,
  setStatus,
  updateProfile,
} from "@/server/services/profile";
import { json } from "@/server/validation";

export const profileRouter = sessionRouter()
  // Page data (account page): whether a Microsoft account is linked, which
  // decides the "Use Microsoft photo" control. The caller's own row only.
  .get("/account", async (c) => {
    const session = await requireSession();
    const microsoftAccount = await db.query.accounts.findFirst({
      where: { userId: session.user.id, providerId: "microsoft" },
      columns: { id: true },
    });
    return c.json({ hasMicrosoftAccount: Boolean(microsoftAccount) });
  })
  .post(
    "/update-profile",
    json(z.object({ input: profileInputSchema })),
    async (c) => c.json(await updateProfile(c.req.valid("json").input))
  )
  .post(
    "/set-status",
    json(z.object({ input: statusInputSchema })),
    async (c) => c.json(await setStatus(c.req.valid("json").input))
  )
  .post("/clear-status", async (c) => c.json(await clearStatus()))
  .post(
    "/admin-update-profile",
    // Name and title rules live in the service, which answers with the
    // translated message the dialog shows.
    json(
      z.object({
        input: z.object({
          userId: uuidSchema,
          name: z.string().max(1000),
          title: z.string().max(1000).nullable(),
        }),
      })
    ),
    async (c) => c.json(await adminUpdateProfile(c.req.valid("json").input))
  )
  .post(
    "/admin-remove-avatar",
    json(z.object({ input: z.object({ userId: uuidSchema }) })),
    async (c) => c.json(await adminRemoveAvatar(c.req.valid("json").input))
  )
  .post(
    "/set-my-time-zone",
    json(z.object({ timezone: timeZoneSchema })),
    async (c) => c.json(await setMyTimeZone(c.req.valid("json").timezone))
  )
  .post(
    "/set-accent-color",
    json(z.object({ input: accentSchema })),
    async (c) => c.json(await setAccentColor(c.req.valid("json").input))
  )
  .post(
    "/set-motif",
    json(z.object({ input: motifPreferenceSchema })),
    async (c) => c.json(await setMotif(c.req.valid("json").input))
  );

/**
 * Ported from app/api/avatars/**, mounted at /api/avatars: same paths and
 * responses (<UserAvatar> renders the GET URL, the profile form posts the
 * upload). Self-service only — the session user is the subject of every write,
 * never a path param.
 */
export const avatarsRouter = sessionRouter()
  .post("/", async (c) => {
    const session = await requireSession();

    const form = await c.req.raw.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "no_file" }, 400);
    if (file.size > AVATAR_MAX_BYTES)
      return c.json({ error: "too_large" }, 413);

    let result: Awaited<ReturnType<typeof storeAvatar>>;
    try {
      result = await storeAvatar(
        session.user.id,
        Buffer.from(await file.arrayBuffer()),
        "upload"
      );
    } catch (error) {
      console.error("Avatar upload failed:", error);
      return c.json({ error: "storage" }, 502);
    }
    if (!result.ok) return c.json({ error: result.error }, 415);

    await recordActivity({
      actorId: session.user.id,
      action: "profile.updated",
      entityType: "user",
      entityId: session.user.id,
      data: { user: session.user.name },
    });
    return c.json({ image: result.image });
  })
  .delete("/", async (c) => {
    const session = await requireSession();
    await removeAvatar(session.user.id);
    return c.body(null, 204);
  })
  /** "Use Microsoft photo": forced import for the signed-in user. */
  .post("/microsoft", async (c) => {
    const session = await requireSession();
    try {
      const result = await importMicrosoftAvatar(session.user.id, {
        force: true,
      });
      return c.json({ result });
    } catch (error) {
      console.error("Forced Microsoft avatar import failed:", error);
      return c.json({ error: "graph" }, 502);
    }
  })
  /**
   * Serve an avatar at a fixed size. Every signed-in user may see every
   * avatar. The path is content-addressed, so the response is immutable. A
   * superseded hash 404s once its object is deleted and <UserAvatar> falls
   * back to initials.
   */
  .get("/:userId/:hash", async (c) => {
    const { userId, hash } = c.req.param();
    if (!uuidSchema.safeParse(userId).success || !AVATAR_HASH_RE.test(hash)) {
      return new Response("Bad request", { status: 400 });
    }
    const size = snapAvatarSize(c.req.query("s") ?? null);

    let upstream: Response;
    try {
      upstream = await fetch(
        imgproxyUrl(avatarKey(userId, hash), { width: size, fill: true }),
        { headers: { Accept: c.req.header("accept") ?? "image/*" } }
      );
    } catch (error) {
      console.error(
        `imgproxy fetch failed for avatar ${userId}/${hash}:`,
        error
      );
      return new Response("Image service error", { status: 502 });
    }
    if (upstream.status === 404)
      return new Response("Not found", { status: 404 });
    if (!upstream.ok || !upstream.body) {
      console.error(
        `imgproxy returned ${upstream.status} for avatar ${userId}/${hash}`
      );
      return new Response("Image service error", { status: 502 });
    }
    return new Response(upstream.body, {
      headers: {
        "Content-Type": upstream.headers.get("content-type") ?? "image/webp",
        "Cache-Control": "private, max-age=31536000, immutable",
        "Content-Disposition": "inline",
        Vary: "Accept",
      },
    });
  });
