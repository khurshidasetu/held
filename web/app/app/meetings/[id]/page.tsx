import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { eq, and, asc } from "drizzle-orm";
import {
  db,
  meetings,
  speakers,
  transcriptSegments,
  meetingSummaries,
  attendees,
} from "@/db";
import { MeetingProcessingState } from "./MeetingProcessingState";
import { SendEmailForm } from "./SendEmailForm";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function MeetingPage({ params }: PageProps) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.userId, userId)))
    .limit(1);

  if (!meeting) notFound();

  const meetingAttendees = await db
    .select()
    .from(attendees)
    .where(eq(attendees.meetingId, id));

  if (
    meeting.status === "pending" ||
    meeting.status === "processing"
  ) {
    return <MeetingProcessingState meeting={meeting} />;
  }

  if (meeting.status === "awaiting_speaker_naming") {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold">{meeting.title}</h1>
        <div className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
          Speaker naming hasn&rsquo;t been completed yet. Reopen the recorder
          to finish naming.
        </div>
      </div>
    );
  }

  if (meeting.status === "failed") {
    return (
      <div className="space-y-4">
        <Link
          href="/app"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back
        </Link>
        <h1 className="text-2xl font-semibold">{meeting.title}</h1>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-700 dark:text-red-300">
          <div className="font-semibold mb-1">Processing failed</div>
          <div>{meeting.errorMessage ?? "Unknown error"}</div>
        </div>
      </div>
    );
  }

  // status === "complete"
  const speakerRows = await db
    .select()
    .from(speakers)
    .where(eq(speakers.meetingId, id));

  const segments = await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.meetingId, id))
    .orderBy(asc(transcriptSegments.startSeconds));

  const [summary] = await db
    .select()
    .from(meetingSummaries)
    .where(eq(meetingSummaries.meetingId, id))
    .limit(1);

  const speakerNameById = new Map(
    speakerRows.map((s, i) => [s.id, s.displayName ?? `Speaker ${i + 1}`])
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/app"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Back
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight mt-1">
          {meeting.title}
        </h1>
        <p className="text-xs text-muted-foreground">
          {new Date(meeting.createdAt).toLocaleString()}
          {meeting.durationSeconds
            ? ` · ${formatDuration(meeting.durationSeconds)}`
            : null}
        </p>
      </div>

      {summary && (
        <section className="rounded-lg border border-border bg-card p-5 space-y-5">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Summary
            </h2>
            <p className="mt-2 leading-relaxed">{summary.summary}</p>
          </div>

          {summary.actionItems.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Action items
              </h2>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                {summary.actionItems.map((a, i) => (
                  <li key={i}>
                    {a.text}
                    {a.owner ? (
                      <span className="text-muted-foreground"> ({a.owner})</span>
                    ) : null}
                    {a.dueDate ? (
                      <span className="text-muted-foreground"> — {a.dueDate}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.decisions.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Decisions
              </h2>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                {summary.decisions.map((d, i) => (
                  <li key={i}>
                    {d.text}
                    {d.rationale ? (
                      <span className="text-muted-foreground"> — {d.rationale}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.topics.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Topics
              </h2>
              <ul className="mt-2 list-disc pl-5 space-y-1">
                {summary.topics.map((t, i) => (
                  <li key={i}>
                    <strong>{t.name}</strong>
                    {t.summary ? `: ${t.summary}` : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Transcript
        </h2>
        <ol className="space-y-2">
          {segments.map((s) => (
            <li
              key={s.id}
              className="flex gap-3 rounded-md border border-border bg-card px-4 py-3"
            >
              <div className="w-28 shrink-0 text-sm font-medium text-brand">
                {speakerNameById.get(s.speakerId) ?? "Unknown"}
              </div>
              <div className="flex-1 leading-relaxed">{s.text}</div>
            </li>
          ))}
        </ol>
      </section>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Send to attendees
        </h2>
        <SendEmailForm
          meetingId={meeting.id}
          attendees={meetingAttendees.map((a) => a.email)}
        />
      </section>
    </div>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
