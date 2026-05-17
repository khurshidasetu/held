import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db, meetings } from "@/db";
import { getCurrentUserId } from "@/lib/auth";
import { MeetingsList } from "./MeetingsList";

export const dynamic = "force-dynamic";

export default async function PreviousMeetingsPage() {
  const userId = await getCurrentUserId();

  const list = await db
    .select({
      id: meetings.id,
      title: meetings.title,
      createdAt: meetings.createdAt,
      durationSeconds: meetings.durationSeconds,
      status: meetings.status,
    })
    .from(meetings)
    .where(eq(meetings.userId, userId))
    .orderBy(desc(meetings.createdAt))
    .limit(50);

  return (
    <div className="page-fade space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/app"
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Capture
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight mt-1">
            Previous meetings
          </h1>
          <p className="text-sm text-muted-foreground">
            Everything Held has recorded for you.
          </p>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-10 text-center space-y-3">
          <p className="text-muted-foreground">No meetings yet.</p>
          <Link
            href="/app"
            className="tap-target inline-flex items-center px-4 py-2 rounded-md bg-brand text-brand-foreground text-sm font-medium hover:bg-brand-hover"
          >
            Record your first meeting
          </Link>
        </div>
      ) : (
        <MeetingsList meetings={list} />
      )}
    </div>
  );
}
