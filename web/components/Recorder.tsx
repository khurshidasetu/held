"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type RecorderProps = {
  /** Optional. If omitted, the server auto-generates "Meeting on <date>". */
  meetingTitle?: string;
  /** Optional. Attendee emails captured up front; Held usually defers this
   * to the post-meeting Share flow on the Result Card. */
  attendeeEmails?: string[];
};

// localStorage flag that records the user has acknowledged the recording
// consent once. Versioned so we can re-prompt if the legal text materially
// changes (bump to :v2 etc.).
const CONSENT_ACK_KEY = "held:consent-ack:v1";

// Sticky "Just me (one speaker)" preference. The user typically records
// the same way over and over (solo or with the same team) — persisting
// the toggle saves them re-picking it every session. Set to "1" when
// the user wants to bypass diarization.
const SOLO_PREF_KEY = "held:solo-recording:v1";

// The recorder used to host the Speaker Naming Popup directly and stayed
// on screen until naming was done. We now navigate to the meeting page
// the instant the upload returns, and the meeting page hosts the popup
// inline (driven by polling on the meeting status). So the recorder
// itself only sees three phases: idle → recording → handing off.
type Phase = "idle" | "recording" | "uploading";

// Order matters — first supported wins. iOS Safari only supports MP4.
const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
];

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const m of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}

export function Recorder({
  meetingTitle = "",
  attendeeEmails = [],
}: RecorderProps = {}) {
  const router = useRouter();

  // Consent is one-time, persisted in localStorage. On first mount we read
  // the flag; if set, the Record button is enabled immediately and no
  // checkbox is shown. If cleared, we render the checkbox and write the
  // flag the moment the user ticks it.
  const [consented, setConsented] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(CONSENT_ACK_KEY) === "1") {
        setConsented(true);
      }
    } catch {
      // Private mode / disabled storage — fall back to per-session consent.
    }
  }, []);
  function acknowledgeConsent(v: boolean) {
    setConsented(v);
    if (v) {
      try {
        window.localStorage.setItem(CONSENT_ACK_KEY, "1");
      } catch {
        // ignore
      }
    }
  }

  // "Just me" toggle — sticky across sessions. When checked, the upload
  // sends singleSpeaker=1, which makes identify-speakers skip pyannote
  // and create one speaker covering the whole audio. Default off so
  // multi-person meetings continue to work as before.
  const [singleSpeaker, setSingleSpeakerState] = useState(false);
  useEffect(() => {
    try {
      if (window.localStorage.getItem(SOLO_PREF_KEY) === "1") {
        setSingleSpeakerState(true);
      }
    } catch {
      // ignore
    }
  }, []);
  function setSingleSpeaker(v: boolean) {
    setSingleSpeakerState(v);
    try {
      window.localStorage.setItem(SOLO_PREF_KEY, v ? "1" : "0");
    } catch {
      // ignore
    }
  }

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const mimeRef = useRef<string>("");

  useEffect(() => {
    return () => {
      stopTimer();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  function startTimer() {
    startedAtRef.current = Date.now();
    setElapsed(0);
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
  }

  function stopTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }

  async function startRecording() {
    setError(null);

    // Consent gate — checked at click time rather than via `disabled` on
    // the button. iOS Safari occasionally drops React's onChange when a
    // <label> wraps a checkbox, which would leave the React state at
    // `false` even though the visual checkbox toggles. Doing the check
    // here means the legal gate is still enforced; we just avoid the
    // "mysterious disabled button" failure mode.
    if (!consented) {
      setError(
        "All participants must consent to being recorded. Tap the box above first."
      );
      return;
    }

    // Mic API requires a secure context (HTTPS or localhost on the same
    // device). Hitting the LAN IP over HTTP from a phone → undefined.
    // Detect early so the error is human-readable.
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      setError(
        "Microphone access requires a secure context. Open this URL over HTTPS, or use localhost on the same device."
      );
      return;
    }

    const mime = pickMimeType();
    if (!mime) {
      setError(
        "Your browser does not support audio recording. Try the latest Chrome, Safari, or Firefox."
      );
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream, { mimeType: mime });
      mediaRecorderRef.current = recorder;
      mimeRef.current = mime;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.start(1000);
      setPhase("recording");
      startTimer();
    } catch (err) {
      setError(
        err instanceof Error
          ? `Microphone access failed: ${err.message}`
          : "Microphone access failed"
      );
    }
  }

  async function stopRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    stopTimer();

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    await stopped;

    const blob = new Blob(chunksRef.current, { type: mimeRef.current });
    await uploadAndHandoff(blob);
  }

  // Upload the recording and immediately navigate to the meeting page.
  // The meeting page polls and renders the Speaker Naming Popup inline
  // the moment diarization completes (which we kicked off server-side
  // as a fire-and-forget from the upload route). The user is no longer
  // stuck on a full-screen "Identifying speakers..." spinner for 30-90s.
  async function uploadAndHandoff(blob: Blob) {
    setPhase("uploading");
    setError(null);

    try {
      const fd = new FormData();
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      // Default title if the caller didn't supply one — Held's capture flow
      // is "one tap", so most meetings won't have a title up front.
      const titleToSend =
        meetingTitle.trim() ||
        `Meeting on ${new Date().toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}`;
      fd.append("audio", blob, `recording.${ext}`);
      fd.append("title", titleToSend);
      fd.append("attendees", JSON.stringify(attendeeEmails));
      fd.append("durationSeconds", String(elapsed));
      // Recording-time hint: when set, identify-speakers will skip
      // pyannote and synthesize a single speaker segment covering the
      // whole audio. See upload route + identify-speakers/route.ts.
      fd.append("singleSpeaker", singleSpeaker ? "1" : "0");

      const uploadRes = await fetch("/api/meetings/upload", {
        method: "POST",
        body: fd,
      });
      if (!uploadRes.ok) {
        throw new Error(await uploadRes.text());
      }
      const { meetingId } = (await uploadRes.json()) as {
        meetingId: string;
      };
      router.push(`/app/meetings/${meetingId}`);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again."
      );
      setPhase("idle");
    }
  }

  return (
    <div className="space-y-4">
      {!consented && (
        <ConsentGate
          consented={consented}
          onChange={acknowledgeConsent}
          disabled={phase !== "idle"}
        />
      )}

      {/* Recording-time hint: "Just me" toggle. Hidden once recording starts
          so the button doesn't shift around. Persisted across sessions via
          localStorage. */}
      {phase === "idle" && (
        <label
          htmlFor="held-single-speaker"
          className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2.5 cursor-pointer hover:bg-foreground/[0.02]"
        >
          <div className="text-sm">
            <span className="font-medium text-foreground">
              Just me (one speaker)
            </span>
            <span className="block text-xs text-muted-foreground mt-0.5">
              Skips speaker detection — faster, and avoids splitting a solo
              voice into multiple speakers.
            </span>
          </div>
          <input
            id="held-single-speaker"
            type="checkbox"
            checked={singleSpeaker}
            onChange={(e) => setSingleSpeaker(e.target.checked)}
            className="shrink-0 h-5 w-5 rounded border-border accent-brand"
          />
        </label>
      )}

      <div className="rounded-lg border border-border bg-card p-6 flex flex-col items-center gap-5">
        {phase === "idle" && (
          <button
            type="button"
            onClick={startRecording}
            aria-label="Record"
            aria-disabled={!consented || undefined}
            className="group relative inline-flex items-center justify-center w-28 h-28 rounded-full bg-brand text-brand-foreground hover:bg-brand-hover transition-all duration-300 shadow-xl shadow-brand/30 hover:shadow-2xl hover:shadow-brand/40 hover:scale-[1.03] active:scale-95 aria-disabled:opacity-50 aria-disabled:hover:scale-100"
          >
            {/* Concentric dot — the universal "record" affordance. */}
            <span
              className="block w-7 h-7 rounded-full bg-brand-foreground transition-transform duration-300 group-hover:scale-110"
              aria-hidden="true"
            />
          </button>
        )}

        {phase === "idle" && (
          <span className="text-sm text-muted-foreground">
            {consented ? "Tap to record" : "Check the consent box, then tap"}
          </span>
        )}

        {phase === "recording" && (
          <>
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
              </span>
              <span className="text-3xl font-mono tabular-nums">
                {formatTime(elapsed)}
              </span>
            </div>
            <button
              type="button"
              onClick={stopRecording}
              aria-label="Stop"
              className="inline-flex items-center justify-center w-28 h-28 rounded-full bg-foreground text-background transition-all duration-300 shadow-xl shadow-foreground/20 hover:shadow-2xl hover:shadow-foreground/30 hover:scale-[1.03] active:scale-95"
            >
              {/* Square — the universal "stop" affordance. */}
              <span
                className="block w-7 h-7 rounded-md bg-background"
                aria-hidden="true"
              />
            </button>
            <span className="text-sm text-muted-foreground">
              Tap to stop
            </span>
          </>
        )}

        {phase === "uploading" && <FullScreenLoading text="Uploading audio…" />}
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
          {error}
        </div>
      )}
    </div>
  );
}

function ConsentGate({
  consented,
  onChange,
  disabled,
}: {
  consented: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label
      htmlFor="held-consent"
      className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer ${
        consented
          ? "border-brand bg-brand/5"
          : "border-border bg-card"
      } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
    >
      <input
        id="held-consent"
        type="checkbox"
        checked={consented}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="mt-1 h-5 w-5 rounded border-border accent-brand"
      />
      <div className="text-sm">
        <div className="font-medium text-foreground">
          All participants have consented to being recorded.
        </div>
        <div className="text-muted-foreground mt-1">
          Recording without consent may be illegal in your jurisdiction. You
          can&rsquo;t start a recording until this is checked.
        </div>
      </div>
    </label>
  );
}

function FullScreenLoading({ text }: { text: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur">
      <div className="flex flex-col items-center gap-4 text-center px-6">
        <div className="h-10 w-10 rounded-full border-4 border-brand/20 border-t-brand animate-spin" />
        <p className="text-foreground font-medium">{text}</p>
      </div>
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
