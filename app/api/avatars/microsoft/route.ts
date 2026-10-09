import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth-session";
import { importMicrosoftAvatar } from "@/lib/avatars-microsoft";

/** "Use Microsoft photo": forced import for the signed-in user. */
export async function POST(): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  try {
    const result = await importMicrosoftAvatar(session.user.id, { force: true });
    revalidatePath("/", "layout");
    return NextResponse.json({ result });
  } catch (error) {
    console.error("Forced Microsoft avatar import failed:", error);
    return NextResponse.json({ error: "graph" }, { status: 502 });
  }
}
