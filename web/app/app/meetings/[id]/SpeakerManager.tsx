"use client";

/**
 * Post-completion speaker management. Renders one chip per speaker at the
 * top of the transcript section. Tapping a chip expands an inline "Merge
 * into..." picker — same UX shape as the popup's merge action, but
 * available AFTER /process has run.
 *
 * Why this matters: pyannote sometimes splits a single voice into 2-3
 * "speakers" that survive both the identify-speakers prune and the
 * /process prune (each cluster has enough audio to pass the 1 s
 * threshold). The popup's merge action handles that during naming, but
 * it has occasionally not propagated through to the DB on long
 * recordings. This post-hoc merger is the bulletproof fallback: it
 * operates directly on transcript_segments / speaker rows, no
 * diarization-segment rewrite needed, so there's nothing in the pipeline
 * left to silently fail.
 */
import { useState, useTransition } from "react";
import { mergeMeetingSpeakers } from "./actions";

type Speaker = {
  id: string;
  displayName: string;
  /** Index used for the per-speaker colour swatch. Must match what the
   *  parent uses on the transcript rows so the chip's swatch lines up. */
  paletteIndex: number;
  /** Hex colour string from SPEAKER_PALETTE. Lets us inherit the same
   *  per-speaker tint the transcript uses. */
  color: string;
};

type Props = {
  meetingId: string;
  speakers: Speaker[];
};

export function SpeakerManager({ meetingId, speakers }: Props) {
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Don't show the manager unless there's something to merge.
  if (speakers.length < 2) return null;

  function openPicker(speakerId: string) {
    setPickerFor((curr) => (curr === speakerId ? null : speakerId));
    setError(null);
  }

  function merge(fromId: string, intoId: string) {
    setError(null);
    startTransition(async () => {
      try {
        await mergeMeetingSpeakers(meetingId, fromId, intoId);
        setPickerFor(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't merge speakers");
      }
    });
  }

  const sourceSpeaker = pickerFor
    ? speakers.find((s) => s.id === pickerFor)
    : null;
  const mergeTargets = sourceSpeaker
    ? speakers.filter((s) => s.id !== sourceSpeaker.id)
    : [];

  return (
    <div className="mb-4 rounded-lg border border-border bg-card/50 p-3 space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Speakers
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {speakers.map((s) => {
          const isActive = pickerFor === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => openPicker(s.id)}
              disabled={pending}
              aria-expanded={isActive}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-colors disabled:opacity-40 ${
                isActive
                  ? "border-foreground/30 bg-foreground/5"
                  : "border-border hover:bg-foreground/5"
              }`}
            >
              <span
                aria-hidden="true"
                className="inline-block w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: s.color }}
              />
              <span style={{ color: s.color }}>{s.displayName}</span>
            </button>
          );
        })}
      </div>

      {sourceSpeaker && (
        <div className="pt-2 border-t border-border/60 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">
            Merge <span className="font-medium text-foreground">{sourceSpeaker.displayName}</span> into&nbsp;
          </span>
          {mergeTargets.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => merge(sourceSpeaker.id, t.id)}
              disabled={pending}
              className="inline-flex items-center px-2 py-0.5 rounded-full bg-brand/10 text-brand hover:bg-brand/20 text-[11px] font-medium disabled:opacity-40"
            >
              {t.displayName}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPickerFor(null)}
            disabled={pending}
            className="inline-flex items-center px-2 py-0.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5 text-[11px] disabled:opacity-40"
          >
            Cancel
          </button>
          {pending && (
            <span className="text-[11px] text-muted-foreground">Merging…</span>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-600 mt-1">
          {error}
        </p>
      )}
    </div>
  );
}
