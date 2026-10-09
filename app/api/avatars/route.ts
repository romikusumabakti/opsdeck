import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { recordActivity } from "@/lib/activity";
import { getServerSession } from "@/lib/auth-session";
import { removeAvatar, storeAvatar } from "@/lib/avatars";
import { AVATAR_MAX_BYTES } from "@/lib/validation";

// Self-service only: the session user is the subject, never a path param.

export async function POST(request: Request): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no_file" }, { status: 400 });
  if (file.size > AVATAR_MAX_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  let result: Awaited<ReturnType<typeof storeAvatar>>;
  try {
    result = await storeAvatar(session.user.id, Buffer.from(await file.arrayBuffer()), "upload");
  } catch (error) {
    console.error("Avatar upload failed:", error);
    return NextResponse.json({ error: "storage" }, { status: 502 });
  }
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 415 });

  await recordActivity({
    actorId: session.user.id,
    action: "profile.updated",
    entityType: "user",
    entityId: session.user.id,
    data: { user: session.user.name },
  });
  revalidatePath("/", "layout");
  return NextResponse.json({ image: result.image });
}

export async function DELETE(): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  await removeAvatar(session.user.id);
  revalidatePath("/", "layout");
  return new Response(null, { status: 204 });
}
