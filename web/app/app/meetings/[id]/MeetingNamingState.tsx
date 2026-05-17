"use client";

/**
 * Shown inline on the meeting page once diarization has produced
 * speakers but the user hasn't named them yet. Hosts the
 * SpeakerNamingPopup (previously rendered from inside the Recorder) and
 * fires save-speakers on submit / skip. Server kicks off the rest of
 * the pipeline (STT → merge → summary) fire-and-forget from there.
 *
 * Polling: identify-speakers now runs name inference (STT + LLM extract
 * of self-introductions) AFTER inserting speaker rows, so the popup can
 * appear immediately. While the popup is open and any speaker is still
 * unnamed, we router.refresh() every 3 s — the server re-fetches the
 * speakers table, and any `displayName` the background task just wrote
 * arrives as a fresh prop to the popup, which adopts it for empty inputs.
 * The poll stops once every speaker has a name or after 45 s, whichever
 * comes first.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  SpeakerNamingPopup,
  type DetectedSpeaker,
} from "@/components/SpeakerNamingPopup";

type Props = {
  meetingId: string;
  speakers: DetectedSpeaker[];
};

const POLL_INTERVAL_MS = 3000;
const POLL_BUDGET_MS = 45_000;

export function MeetingNamingState({ meetingId, speakers }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  // Late-arriving name inference. Poll while at least one speaker still
  // lacks a displayName and the budget hasn't elapsed.
  useEffect(() => {
    const anyMissing = speakers.some((s) => !s.currentName);
    if (!anyMissing) return;

    let cancelled = false;
    let tick: ReturnType<typeof setTimeout>;
    const start = Date.now();

    function poll() {
      if (cancelled) return;
      if (Date.now() - start > POLL_BUDGET_MS) return;
      router.refresh();
      tick = setTimeout(poll, POLL_INTERVAL_MS);
    }
    tick = setTimeout(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(tick);
    };
  }, [speakers, router]);

  async function save(
    detected: { speakerLabel: string; displayName: string | null }[],
    silentAttendees: { displayName: string }[],
    merges: { from: string; into: string }[]
  ) {
    setError(null);
    try {
      const res = await fetch(
        `/api/meetings/${meetingId}/save-speakers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ detected, silentAttendees, merges }),
        }
      );
      if (!res.ok) {
        throw new Error(await res.text());
      }
      // save-speakers transitions status → processing and fire-and-
      // forget triggers /process. Refresh so we render the
      // MeetingProcessingState next.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save speakers.");
    }
  }

  return (
    <>
      <SpeakerNamingPopup
        speakers={speakers}
        onSubmit={save}
        onSkip={() =>
          save(
            speakers.map((s) => ({
              speakerLabel: s.speakerLabel,
              displayName: null,
            })),
            [],
            []
          )
        }
      />
      {error && (
        <div
          className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] max-w-sm rounded-md border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300 shadow-lg"
          role="alert"
        >
          {error}
        </div>
      )}
    </>
  );
}
