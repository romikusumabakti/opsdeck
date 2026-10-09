import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/auth-session";
import { getUserCard } from "@/lib/people/card";
import { uuidSchema } from "@/lib/validation";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const session = await getServerSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success)
    return new Response("Bad request", { status: 400 });
  const card = await getUserCard(id, session.user);
  if (!card) return new Response("Not found", { status: 404 });
  // Status and name change; the client cache (60 s) absorbs repeat hovers.
  return NextResponse.json(card, {
    headers: { "Cache-Control": "private, no-store" },
  });
}
