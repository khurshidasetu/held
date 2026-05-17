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
import { useEffect, useRef, useState } from "react";

export type DetectedSpeaker = {
  speakerLabel: string;
  /** Presigned URL to the extracted MP3 clip. Null if extraction failed. */
  sampleUrl: string | null;
  /**
   * Existing displayName on the speaker row, if any. Used to pre-fill the
   * name input (e.g. when the identify-speakers step has already extracted
   * a self-introduced name like "Hi I'm Alex"). User can edit or clear.
   */
  currentName?: string | null;
};

type SilentEntry = {
  id: string;
  name: string;
};

/**
 * Merge directive emitted on submit. `from` is the duplicate speaker
 * pyannote produced; `into` is the real speaker they should be folded
 * into. save-speakers rewrites the cached diarization segments so the
 * /process merge step attributes both labels' words to one row.
 */
type MergeDirective = { from: string; into: string };

type Props = {
  speakers: DetectedSpeaker[];
  onSubmit: (
    detected: { speakerLabel: string; displayName: string | null }[],
    silentAttendees: { displayName: string }[],
    merges: MergeDirective[]
  ) => void | Promise<void>;
  onSkip: () => void | Promise<void>;
};

export function SpeakerNamingPopup({ speakers, onSubmit, onSkip }: Props) {
  // Seed the input state from any name we already have on the speaker row
  // (filled by the identify-speakers self-intro extractor). Falls back to ""
  // for speakers we couldn't auto-detect.
  const [names, setNames] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      speakers.map((s) => [s.speakerLabel, s.currentName ?? ""])
    )
  );
  // Labels the user explicitly removed — these speakers are not the same
  // person as anyone else, they're just noise (e.g. a passing voice or
  // a phantom pyannote cluster). save-speakers deletes the row and any
  // words attributed to that label drop out of the transcript entirely.
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  // Merge map: { fromLabel -> intoLabel }. Lets the user fix the common
  // case where pyannote splits one real person into two speakers. Words
  // attributed to `from` get re-attributed to `into` in /process via the
  // diarization-segment rewrite, so NOTHING is lost — unlike `removed`.
  const [mergedInto, setMergedInto] = useState<Map<string, string>>(
    () => new Map()
  );
  // The speaker label whose merge-target picker is currently expanded.
  // Only one picker visible at a time; clicking another row's "Same as…"
  // button replaces this.
  const [mergePickerFor, setMergePickerFor] = useState<string | null>(null);
  const [silents, setSilents] = useState<SilentEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);

  // Reactive name pre-fill. The popup is mounted as soon as identify-speakers
  // inserts the speaker rows, but the background name-inference task may
  // still be running. When it lands, the parent re-fetches and passes us a
  // new `speakers` array with currentName populated; we adopt those names
  // ONLY for inputs the user hasn't typed in yet, so we never clobber
  // manual entries.
  useEffect(() => {
    setNames((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const s of speakers) {
        const inferred = s.currentName?.trim();
        if (!inferred) continue;
        const userValue = next[s.speakerLabel]?.trim() ?? "";
        if (userValue.length === 0 && next[s.speakerLabel] !== inferred) {
          next[s.speakerLabel] = inferred;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [speakers]);

  // Currently-playing label → so we can pause the previous one when a new
  // play button is pressed.
  const [playingLabel, setPlayingLabel] = useState<string | null>(null);
  // Per-speaker "couldn't play" flag. Set when <audio> fires onError or
  // when .play() rejects. Shown as a tiny "can't play" hint next to the
  // play button so silent failures stop being silent — and a console.warn
  // lands so future regressions surface in devtools.
  const [playbackError, setPlaybackError] = useState<Record<string, string>>(
    {}
  );
  const audioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());

  // Speakers shown in the main list: anyone the user hasn't removed AND
  // hasn't merged into someone else. The "into" target of a merge stays
  // visible (it absorbs the duplicate).
  const visibleSpeakers = speakers.filter(
    (s) => !removed.has(s.speakerLabel) && !mergedInto.has(s.speakerLabel)
  );

  function removeDetected(label: string) {
    // Pause its audio (if playing) before unmounting the <audio>.
    if (playingLabel === label) {
      audioRefs.current.get(label)?.pause();
      setPlayingLabel(null);
    }
    setRemoved((prev) => {
      const next = new Set(prev);
      next.add(label);
      return next;
    });
    // If this speaker had the merge picker open, close it.
    if (mergePickerFor === label) setMergePickerFor(null);
  }

  function openMergePicker(label: string) {
    setMergePickerFor((curr) => (curr === label ? null : label));
  }

  function mergeIntoSpeaker(fromLabel: string, intoLabel: string) {
    // Pause any audio playing on the about-to-disappear row.
    if (playingLabel === fromLabel) {
      audioRefs.current.get(fromLabel)?.pause();
      setPlayingLabel(null);
    }
    setMergedInto((prev) => {
      const next = new Map(prev);
      next.set(fromLabel, intoLabel);
      return next;
    });
    setMergePickerFor(null);
  }

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
    setPlaybackError((prev) => {
      if (!(label in prev)) return prev;
      const next = { ...prev };
      delete next[label];
      return next;
    });
    audio.currentTime = 0;
    audio.play().then(
      () => setPlayingLabel(label),
      (err: unknown) => {
        // .play() rejects on autoplay block, decoder errors, network
        // failures (404/403), and a few other edge cases. Log + surface
        // to UI so this can't fail silently like it did before.
        console.warn(
          `[SpeakerNamingPopup] play() rejected for ${label}:`,
          err,
          "src=",
          audio.currentSrc || audio.src
        );
        setPlayingLabel(null);
        setPlaybackError((prev) => ({
          ...prev,
          [label]: err instanceof Error ? err.message : "Playback failed",
        }));
      }
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
    const detected = visibleSpeakers.map((s) => ({
      speakerLabel: s.speakerLabel,
      displayName: names[s.speakerLabel]?.trim() || null,
    }));
    const silentAttendees = silents
      .map((s) => ({ displayName: s.name.trim() }))
      .filter((s) => s.displayName.length > 0);
    // Resolve merge chains so the server gets a flat from→ultimate-into
    // map. (User could in theory merge A into B and then later merge B
    // into C; we want A and B both pointing to C.)
    const merges: MergeDirective[] = [];
    for (const [from, into] of mergedInto) {
      let target = into;
      const seen = new Set<string>([from]);
      while (mergedInto.has(target) && !seen.has(target)) {
        seen.add(target);
        target = mergedInto.get(target)!;
      }
      merges.push({ from, into: target });
    }
    try {
      await onSubmit(detected, silentAttendees, merges);
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
      {/*
        max-h-[90dvh] uses the DYNAMIC viewport height — on iOS Safari the
        URL bar eats into 100vh but is excluded from dvh, so the modal no
        longer renders taller than the visible area (which was pushing the
        header above the top edge).
        Flex column with shrink-0 header/footer and flex-1 min-h-0 body so
        only the body scrolls; header + footer stay pinned and visible.
      */}
      <div className="w-full sm:max-w-lg bg-card text-card-foreground rounded-t-2xl sm:rounded-2xl shadow-xl flex flex-col max-h-[90dvh] sm:max-h-[90vh]">
        <div className="shrink-0 px-5 pt-5 pb-3 border-b border-border">
          <h2
            id="speaker-naming-title"
            className="text-lg font-semibold tracking-tight"
          >
            Who&rsquo;s who? We detected {visibleSpeakers.length}{" "}
            {visibleSpeakers.length === 1 ? "speaker" : "speakers"} in this meeting.
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Name each speaker to make the transcript easier to read. You can
            skip this &mdash; speakers will be labeled &ldquo;Speaker 1&rdquo;,
            &ldquo;Speaker 2&rdquo;, etc.
          </p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
          {visibleSpeakers.length === 0 && (
            <p className="text-sm text-muted-foreground italic">
              All detected speakers were removed. Their words will be dropped
              from the transcript.
            </p>
          )}
          {visibleSpeakers.map((s, i) => {
            const label = `Speaker ${i + 1}`;
            const isPlaying = playingLabel === s.speakerLabel;
            const showMergePicker = mergePickerFor === s.speakerLabel;
            // Other visible speakers this row could be merged into.
            const mergeCandidates = visibleSpeakers
              .map((other, otherIdx) => ({ other, idx: otherIdx }))
              .filter(({ other }) => other.speakerLabel !== s.speakerLabel);
            return (
              <div
                key={s.speakerLabel}
                className="rounded-lg border border-border bg-background"
              >
                <div className="flex items-center gap-3 p-2">
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
                      title={
                        playbackError[s.speakerLabel]
                          ? `Couldn't play: ${playbackError[s.speakerLabel]}`
                          : undefined
                      }
                      className={`tap-target inline-flex items-center justify-center rounded-full border border-border hover:bg-foreground/5 ${
                        playbackError[s.speakerLabel]
                          ? "text-red-600 border-red-500/30"
                          : ""
                      }`}
                    >
                      {isPlaying ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <audio
                      ref={setAudioRef(s.speakerLabel)}
                      src={s.sampleUrl}
                      preload="none"
                      onEnded={() => setPlayingLabel(null)}
                      onError={(e) => {
                        // Network/decode error on the <audio> element. Mirrors
                        // the .play() reject path so both failure modes
                        // surface the same way. MediaError codes:
                        //   1 ABORTED, 2 NETWORK, 3 DECODE, 4 SRC_NOT_SUPPORTED
                        const el = e.currentTarget;
                        const code = el.error?.code;
                        const msg =
                          code === 4
                            ? "Sample format unsupported"
                            : code === 3
                              ? "Sample failed to decode"
                              : code === 2
                                ? "Network error fetching sample"
                                : "Couldn't load sample";
                        console.warn(
                          `[SpeakerNamingPopup] <audio> error for ${s.speakerLabel}:`,
                          msg,
                          "code=",
                          code,
                          "src=",
                          el.currentSrc || el.src
                        );
                        setPlaybackError((prev) => ({
                          ...prev,
                          [s.speakerLabel]: msg,
                        }));
                        if (playingLabel === s.speakerLabel) {
                          setPlayingLabel(null);
                        }
                      }}
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

                {mergeCandidates.length > 0 && (
                  <button
                    type="button"
                    onClick={() => openMergePicker(s.speakerLabel)}
                    aria-label={`Mark ${label} as the same person as another speaker`}
                    aria-expanded={showMergePicker}
                    title="Same person as another speaker"
                    className={`tap-target inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 ${
                      showMergePicker ? "bg-foreground/10 text-foreground" : ""
                    }`}
                  >
                    <MergeIcon />
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => removeDetected(s.speakerLabel)}
                  aria-label={`Remove ${label} (drops their words from the transcript)`}
                  title="Remove this speaker (noise / not a real participant)"
                  className="tap-target inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-500/10"
                >
                  <TrashIcon />
                </button>
                </div>
                {showMergePicker && (
                  <div className="px-3 pb-3 pt-1 border-t border-border/60 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">
                      Same as&nbsp;
                    </span>
                    {mergeCandidates.map(({ other, idx }) => (
                      <button
                        key={other.speakerLabel}
                        type="button"
                        onClick={() =>
                          mergeIntoSpeaker(s.speakerLabel, other.speakerLabel)
                        }
                        className="tap-target inline-flex items-center px-3 py-1.5 rounded-full bg-brand/10 text-brand hover:bg-brand/20 text-xs font-medium"
                      >
                        Speaker {idx + 1}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => setMergePickerFor(null)}
                      className="tap-target inline-flex items-center px-3 py-1.5 rounded-full text-muted-foreground hover:text-foreground hover:bg-foreground/5 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                )}
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

        <div
          className="shrink-0 px-5 pt-3 border-t border-border space-y-3"
          // env(safe-area-inset-bottom) keeps Continue clear of the iOS
          // home indicator on bezel-less iPhones; falls back to 1.25rem
          // on devices without a safe-area inset.
          style={{
            paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 1.25rem)",
          }}
        >
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

function MergeIcon() {
  // Two arrows converging into one — visual metaphor for "fold this
  // speaker into another." Custom SVG; matches the line weight of the
  // other icons in the row (strokeWidth=2, 18×18).
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="18"
      height="18"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 4 4 8M4 8l4 4M4 8h7a4 4 0 0 1 4 4v8" />
      <path d="M16 4l4 4M20 8l-4 4" />
    </svg>
  );
}
