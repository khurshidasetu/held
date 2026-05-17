import { notFound } from "next/navigation";
import Link from "next/link";
import { eq, and, asc } from "drizzle-orm";
import { getCurrentUserId } from "@/lib/auth";
import {
  db,
  meetings,
  speakers,
  transcriptSegments,
  meetingSummaries,
  attendees,
} from "@/db";
import { MeetingProcessingState } from "./MeetingProcessingState";
import { MeetingIdentifyingState } from "./MeetingIdentifyingState";
import { MeetingNamingState } from "./MeetingNamingState";
import { ShareForm } from "./ShareForm";
import { TranscriptDisclosure } from "./TranscriptDisclosure";
import { getPresignedGetUrl } from "@/lib/storage";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function MeetingPage({ params }: PageProps) {
  const { id } = await params;
  const userId = await getCurrentUserId();

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

  if (meeting.status === "pending" || meeting.status === "processing") {
    return <MeetingProcessingState meeting={meeting} />;
  }

  if (meeting.status === "awaiting_speaker_naming") {
    // Two sub-states distinguished by whether identify-speakers has
    // populated the speakers table yet:
    //   * 0 rows → diarization still running in the background
    //     (fired-and-forgot from /api/meetings/upload). Show the
    //     centered "Identifying speakers…" spinner, which polls and
    //     refreshes us back into this branch with rows present.
    //   * >0 rows → diarization done, show the naming popup inline.
    const speakerRows = await db
      .select()
      .from(speakers)
      .where(eq(speakers.meetingId, id));

    if (speakerRows.length === 0) {
      return <MeetingIdentifyingState meetingId={id} />;
    }

    // Build presigned URLs for the sample MP3 clips so the popup's
    // ▶ buttons work. Speakers table stores the storage key in
    // sample_audio_url; we re-sign here on each render so the URLs
    // are fresh.
    const detected = await Promise.all(
      speakerRows
        .filter((s) => !s.isSilentAttendee)
        .map(async (s) => ({
          speakerLabel: s.speakerLabel,
          sampleUrl: s.sampleAudioUrl
            ? await getPresignedGetUrl(s.sampleAudioUrl, 60 * 60)
            : null,
        }))
    );

    // IMPORTANT: don't put MeetingNamingState inside the page-fade wrapper.
    // page-fade animates `transform`, which makes that <div> the containing
    // block for the popup's `position: fixed`, clipping the modal header
    // above the wrapper's edge. Render the popup as a sibling so its
    // `inset-0` is measured against the viewport.
    return (
      <>
        <div className="page-fade space-y-4">
          <div className="text-center py-10">
            <h1 className="text-xl font-semibold">{meeting.title}</h1>
            <p className="text-sm text-muted-foreground mt-2">
              Recording captured. Name the speakers below to continue.
            </p>
          </div>
        </div>
        <MeetingNamingState meetingId={id} speakers={detected} />
      </>
    );
  }

  if (meeting.status === "failed") {
    return (
      <div className="page-fade space-y-4">
        <BackLink />
        <h1 className="text-2xl font-semibold">{meeting.title}</h1>
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-sm text-red-700 dark:text-red-300">
          <div className="font-semibold mb-1">Processing failed</div>
          <div>{meeting.errorMessage ?? "Unknown error"}</div>
        </div>
      </div>
    );
  }

  // status === "complete" — render the Result Card.
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
  // Deterministic per-speaker color so the transcript reads as a script,
  // not a wall of indigo. Order is stable (speakerRows is fetched in insert
  // order) so the same speaker keeps the same color across page loads.
  const SPEAKER_PALETTE = [
    "#6366f1", // indigo
    "#10b981", // emerald
    "#f59e0b", // amber
    "#f43f5e", // rose
    "#0ea5e9", // sky
    "#8b5cf6", // violet
    "#14b8a6", // teal
    "#f97316", // orange
  ];
  const speakerColorById = new Map(
    speakerRows.map((s, i) => [
      s.id,
      SPEAKER_PALETTE[i % SPEAKER_PALETTE.length],
    ])
  );

  return (
    <div className="page-fade space-y-6">
      <header className="space-y-1">
        <BackLink />
        <h1 className="text-2xl font-semibold tracking-tight mt-1">
          {meeting.title}
        </h1>
        <p className="text-xs text-muted-foreground">
          {new Date(meeting.createdAt).toLocaleString()}
          {meeting.durationSeconds
            ? ` · ${formatDuration(meeting.durationSeconds)}`
            : null}
        </p>
      </header>

      {/* Result Card — the answer first, transcript hidden one swipe away. */}
      {summary && (
        <article className="rounded-2xl border border-border bg-card overflow-hidden divide-y divide-border shadow-sm">
          {summary.nextStep && (
            <section className="p-5 bg-brand/5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">
                Next step
              </div>
              <p className="mt-2 text-lg leading-snug text-foreground">
                {summary.nextStep}
              </p>
            </section>
          )}

          <ResultSection
            title="Decisions"
            empty="No decisions captured."
            count={summary.decisions.length}
          >
            <ul className="space-y-2 text-[15px] leading-relaxed">
              {summary.decisions.map((d, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground">·</span>
                  <span>
                    {d.text}
                    {d.rationale ? (
                      <span className="text-muted-foreground">
                        {" "}
                        — {d.rationale}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </ResultSection>

          <ResultSection
            title="Action items"
            empty="No action items."
            count={summary.actionItems.length}
          >
            <ul className="space-y-2 text-[15px] leading-relaxed">
              {summary.actionItems.map((a, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground">·</span>
                  <span>
                    {a.text}
                    {a.owner ? (
                      <span className="text-foreground/80">
                        {" "}
                        <em className="not-italic font-medium">
                          ({a.owner})
                        </em>
                      </span>
                    ) : null}
                    {a.dueDate ? (
                      <span className="text-muted-foreground">
                        {" "}
                        — {a.dueDate}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </ResultSection>

          <ResultSection
            title="Open questions"
            empty="Nothing left open."
            count={summary.openQuestions.length}
          >
            <ul className="space-y-2 text-[15px] leading-relaxed">
              {summary.openQuestions.map((q, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-muted-foreground">·</span>
                  <span>{q.text}</span>
                </li>
              ))}
            </ul>
          </ResultSection>
        </article>
      )}

      {/* Transcript hidden by default — "one swipe away". */}
      <TranscriptDisclosure>
        {summary && (
          <p className="text-sm text-muted-foreground italic mb-3">
            {summary.summary}
          </p>
        )}
        <ol className="space-y-2">
          {segments.map((s) => (
            <li
              key={s.id}
              className="flex gap-3 rounded-md border border-border bg-card px-4 py-3"
            >
              <div
                className="w-28 shrink-0 text-sm font-medium"
                style={{
                  color:
                    speakerColorById.get(s.speakerId) ?? "var(--brand)",
                }}
              >
                {speakerNameById.get(s.speakerId) ?? "Unknown"}
              </div>
              <div className="flex-1 leading-relaxed text-sm">{s.text}</div>
            </li>
          ))}
        </ol>
      </TranscriptDisclosure>

      {/* Share — replaces the old "Send to attendees" with the same Postmark
          flow under the hood. */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Share
        </h2>
        <ShareForm
          meetingId={meeting.id}
          attendees={meetingAttendees.map((a) => a.email)}
        />
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/app/meetings"
      className="text-sm text-muted-foreground hover:text-foreground"
    >
      ← Previous meetings
    </Link>
  );
}

function ResultSection({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="p-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-3">
        {title}
      </div>
      {count > 0 ? (
        children
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </section>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
