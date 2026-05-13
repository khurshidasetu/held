"use client";

/**
 * Speaker Naming Popup.
 *
 * Shown after diarization completes. Lets the user:
 *   1. Listen to a short audio sample of each detected speaker (play button)
 *   2. Type a name for each one (optional — empty falls back to "Speaker N")
 *   3. Add "silent attendees" — people who joined but didn't speak
 *
 * UX rules from the spec:
 *   - Only one sample can play at a time.
 *   - Tap targets must be at least 44×44px on mobile.
 *   - Skip and Continue both proceed; Skip just doesn't save any names.
 *   - Silent attendees with empty names are dropped (not saved).
 */
import { useRef, useState } from "react";

export type DetectedSpeaker = {
  speakerLabel: string;
  /** Presigned URL to the extracted MP3 clip. Null if extraction failed. */
  sampleUrl: string | null;
};

type SilentEntry = {
  id: string;
  name: string;
};

type Props = {
  speakers: DetectedSpeaker[];
  onSubmit: (
    detected: { speakerLabel: string; displayName: string | null }[],
    silentAttendees: { displayName: string }[]
  ) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
};

export function SpeakerNamingPopup({ speakers, onSubmit, onSkip }: Props) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [silents, setSilents] = useState<SilentEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Currently-playing label → so we can pause the previous one when a new
  // play button is pressed.
  const [playingLabel, setPlayingLabel] = useState<string | null>(null);
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());

  function setAudioRef(label: string) {
    return (el: HTMLAudioElement | null) => {
      if (el) audioRefs.current.set(label, el);
      else audioRefs.current.delete(label);
    };
  }

  function togglePlay(label: string) {
    const audio = audioRefs.current.get(label);
    if (!audio) return;
    if (playingLabel === label) {
      audio.pause();
      setPlayingLabel(null);
      return;
    }
    if (playingLabel) {
      audioRefs.current.get(playingLabel)?.pause();
    }
    audio.currentTime = 0;
    audio.play().then(
      () => setPlayingLabel(label),
      () => setPlayingLabel(null)
    );
  }

  function addSilent() {
    setSilents((s) => [
      ...s,
      { id: crypto.randomUUID(), name: "" },
    ]);
  }

  function updateSilent(id: string, name: string) {
    setSilents((s) => s.map((e) => (e.id === id ? { ...e, name } : e)));
  }

  function removeSilent(id: string) {
    setSilents((s) => s.filter((e) => e.id !== id));
  }

  async function handleContinue() {
    setSubmitting(true);
    const detected = speakers.map((s) => ({
      speakerLabel: s.speakerLabel,
      displayName: names[s.speakerLabel]?.trim() || null,
    }));
    const silentAttendees = silents
      .map((s) => ({ displayName: s.name.trim() }))
      .filter((s) => s.displayName.length > 0);
    try {
      await onSubmit(detected, silentAttendees);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkip() {
    setSubmitting(true);
    try {
      await onSkip();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-foreground/40 backdrop-blur-sm p-0 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="speaker-naming-title"
    >
      <div className="w-full sm:max-w-lg bg-card text-card-foreground rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col max-h-[90vh]">
        <div className="px-5 pt-5 pb-3 border-b border-border">
          <h2
            id="speaker-naming-title"
            className="text-lg font-semibold tracking-tight"
          >
            Who&rsquo;s who? We detected {speakers.length}{" "}
            {speakers.length === 1 ? "speaker" : "speakers"} in this meeting.
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Name each speaker to make the transcript easier to read. You can
            skip this &mdash; speakers will be labeled &ldquo;Speaker 1&rdquo;,
            &ldquo;Speaker 2&rdquo;, etc.
          </p>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-3">
          {speakers.map((s, i) => {
            const label = `Speaker ${i + 1}`;
            const isPlaying = playingLabel === s.speakerLabel;
            return (
              <div
                key={s.speakerLabel}
                className="flex items-center gap-3 p-2 rounded-lg border border-border bg-background"
              >
                <div className="w-20 shrink-0 text-sm font-medium text-foreground">
                  {label}
                </div>

                {s.sampleUrl ? (
                  <>
                    <button
                      type="button"
                      onClick={() => togglePlay(s.speakerLabel)}
                      aria-label={
                        isPlaying ? `Pause ${label} sample` : `Play ${label} sample`
                      }
                      className="tap-target inline-flex items-center justify-center rounded-full border border-border hover:bg-foreground/5"
                    >
                      {isPlaying ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <audio
                      ref={setAudioRef(s.speakerLabel)}
                      src={s.sampleUrl}
                      preload="none"
                      onEnded={() => setPlayingLabel(null)}
                    />
                  </>
                ) : (
                  // No sample (extraction failed) — keep grid alignment.
                  <div className="w-11 h-11" aria-hidden="true" />
                )}

                <input
                  type="text"
                  value={names[s.speakerLabel] ?? ""}
                  onChange={(e) =>
                    setNames((n) => ({
                      ...n,
                      [s.speakerLabel]: e.target.value,
                    }))
                  }
                  placeholder="Enter name (e.g., Sarah)"
                  className="tap-target flex-1 min-w-0 px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
            );
          })}

          {silents.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 p-2 rounded-lg border border-dashed border-border bg-background"
            >
              <div className="w-20 shrink-0 text-sm font-medium text-muted-foreground">
                Silent attendee
              </div>
              <div className="w-11 h-11" aria-hidden="true" />
              <input
                type="text"
                value={s.name}
                onChange={(e) => updateSilent(s.id, e.target.value)}
                placeholder="Enter name"
                className="tap-target flex-1 min-w-0 px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-brand"
              />
              <button
                type="button"
                onClick={() => removeSilent(s.id)}
                aria-label="Remove silent attendee"
                className="tap-target inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5"
              >
                <TrashIcon />
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={addSilent}
            className="tap-target w-full inline-flex items-center justify-center gap-2 rounded-lg border border-dashed border-border text-sm text-foreground hover:bg-foreground/5 py-3"
          >
            <PlusIcon /> Add a person who didn&rsquo;t speak
          </button>
        </div>

        <div className="px-5 pt-3 pb-5 border-t border-border space-y-3">
          <p className="text-xs text-muted-foreground text-center">
            Naming makes the transcript much clearer.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={handleSkip}
              disabled={submitting}
              className="tap-target inline-flex items-center px-4 py-2 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-foreground/5 disabled:opacity-40"
            >
              Skip
            </button>
            <button
              type="button"
              onClick={handleContinue}
              disabled={submitting}
              className="tap-target inline-flex items-center px-4 py-2 rounded-md bg-brand text-brand-foreground text-sm font-medium hover:bg-brand-hover disabled:opacity-40"
            >
              {submitting ? "Saving…" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6" />
    </svg>
  );
}
