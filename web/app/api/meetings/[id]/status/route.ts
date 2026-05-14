/**
 * GET /api/meetings/[id]/status — lightweight poller used by the
 * meeting detail page while the meeting is being processed.
 */
import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/lib/auth";
import { eq, and } from "drizzle-orm";
import { db, meetings } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Context) {
  const userId = await getCurrentUserId();

  const { id } = await ctx.params;

  const [meeting] = await db
    .select({ status: meetings.status, errorMessage: meetings.errorMessage })
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.userId, userId)))
    .limit(1);

  if (!meeting) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    status: meeting.status,
    errorMessage: meeting.errorMessage,
  });
}
