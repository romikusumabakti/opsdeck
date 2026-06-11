import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Liveness + readiness probe. Verifies DB connectivity so orchestrators
// (compose healthcheck, k8s readiness) can actually detect a broken backend
// instead of always seeing "ok". Returns 503 when the DB is unreachable.
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ status: "ok" }, { status: 200 });
  } catch {
    return NextResponse.json(
      { status: "error", db: "unreachable" },
      { status: 503 }
    );
  }
}
