import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { db, meetings, type MeetingStatus } from "@/db";
import { DeleteMeetingButton } from "./DeleteMeetingButton";

export const dynamic = "force-dynamic";

const statusLabels: Record<MeetingStatus, string> = {
  pending: "Pending",
  awaiting_speaker_naming: "Naming speakers",
  processing: "Processing",
  complete: "Complete",
  failed: "Failed",
};

const statusClasses: Record<MeetingStatus, string> = {
  pending: "bg-muted/20 text-muted-foreground",
  awaiting_speaker_naming: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  processing: "bg-brand/10 text-brand",
  complete: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
};

export default async function PreviousMeetingsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const list = await db
    .select()
    .from(meetings)
    .where(eq(meetings.userId, userId))
    .orderBy(desc(meetings.createdAt))
    .limit(50);

  return (
    <div className="space-y-6">
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
        <ul className="divide-y divide-border border border-border rounded-lg overflow-hidden bg-card">
          {list.map((m) => (
            <li
              key={m.id}
              className="flex items-center hover:bg-foreground/5"
            >
              {/* Body navigates to the meeting; delete button is a sibling
                  so we don't nest a <button> inside the <Link>. */}
              <Link
                href={`/app/meetings/${m.id}`}
                className="flex-1 min-w-0 flex items-center justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{m.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(m.createdAt).toLocaleString()}
                    {m.durationSeconds
                      ? ` · ${formatDuration(m.durationSeconds)}`
                      : null}
                  </div>
                </div>
                <span
                  className={`shrink-0 text-xs px-2 py-1 rounded-full font-medium ${statusClasses[m.status]}`}
                >
                  {statusLabels[m.status]}
                </span>
              </Link>
              <div className="shrink-0 pr-2">
                <DeleteMeetingButton meetingId={m.id} title={m.title} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
