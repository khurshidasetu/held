"use client";

/**
 * Shown inline on the meeting page once diarization has produced
 * speakers but the user hasn't named them yet. Hosts the
 * SpeakerNamingPopup (previously rendered from inside the Recorder) and
 * fires save-speakers on submit / skip. Server kicks off the rest of
 * the pipeline (STT → merge → summary) fire-and-forget from there.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  SpeakerNamingPopup,
  type DetectedSpeaker,
} from "@/components/SpeakerNamingPopup";

type Props = {
  meetingId: string;
  speakers: DetectedSpeaker[];
};

export function MeetingNamingState({ meetingId, speakers }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function save(
    detected: { speakerLabel: string; displayName: string | null }[],
    silentAttendees: { displayName: string }[]
  ) {
    setError(null);
    try {
      const res = await fetch(
        `/api/meetings/${meetingId}/save-speakers`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ detected, silentAttendees }),
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
