"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { SpeakerNamingPopup, type DetectedSpeaker } from "./SpeakerNamingPopup";

type RecorderProps = {
  meetingTitle: string;
  attendeeEmails: string[];
};

type Phase =
  | "idle"
  | "recording"
  | "uploading"
  | "identifying"
  | "naming"
  | "saving";

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

export function Recorder({ meetingTitle, attendeeEmails }: RecorderProps) {
  const router = useRouter();

  const [consented, setConsented] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [speakers, setSpeakers] = useState<DetectedSpeaker[]>([]);

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
    await uploadAndIdentify(blob);
  }

  async function uploadAndIdentify(blob: Blob) {
    setPhase("uploading");
    setError(null);

    try {
      const fd = new FormData();
      const ext = blob.type.includes("mp4") ? "mp4" : "webm";
      fd.append("audio", blob, `recording.${ext}`);
      fd.append("title", meetingTitle);
      fd.append("attendees", JSON.stringify(attendeeEmails));
      fd.append("durationSeconds", String(elapsed));

      const uploadRes = await fetch("/api/meetings/upload", {
        method: "POST",
        body: fd,
      });
      if (!uploadRes.ok) {
        throw new Error(await uploadRes.text());
      }
      const { meetingId: id } = (await uploadRes.json()) as {
        meetingId: string;
      };
      setMeetingId(id);

      setPhase("identifying");
      const idRes = await fetch(`/api/meetings/${id}/identify-speakers`, {
        method: "POST",
      });
      if (!idRes.ok) {
        throw new Error(await idRes.text());
      }
      const data = (await idRes.json()) as { speakers: DetectedSpeaker[] };
      setSpeakers(data.speakers);
      setPhase("naming");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again."
      );
      setPhase("idle");
    }
  }

  async function onSaveSpeakers(
    detected: { speakerLabel: string; displayName: string | null }[],
    silentAttendees: { displayName: string }[]
  ) {
    if (!meetingId) return;
    setPhase("saving");
    setError(null);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/save-speakers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detected, silentAttendees }),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      router.push(`/app/meetings/${meetingId}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not save speakers."
      );
      setPhase("naming");
    }
  }

  return (
    <div className="space-y-4">
      <ConsentGate
        consented={consented}
        onChange={setConsented}
        disabled={phase !== "idle"}
      />

      <div className="rounded-lg border border-border bg-card p-6 flex flex-col items-center gap-4">
        {phase === "idle" && (
          <button
            type="button"
            onClick={startRecording}
            disabled={!consented}
            className="tap-target inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-brand text-brand-foreground font-medium hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <span className="w-2.5 h-2.5 rounded-full bg-brand-foreground" />
            Record
          </button>
        )}

        {phase === "recording" && (
          <>
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
              </span>
              <span className="text-2xl font-mono tabular-nums">
                {formatTime(elapsed)}
              </span>
            </div>
            <button
              type="button"
              onClick={stopRecording}
              className="tap-target inline-flex items-center justify-center px-6 py-3 rounded-full bg-foreground text-background font-medium hover:opacity-90"
            >
              Stop
            </button>
          </>
        )}

        {(phase === "uploading" || phase === "identifying") && (
          <FullScreenLoading
            text={
              phase === "uploading"
                ? "Uploading audio…"
                : "Identifying speakers… this may take 30–60 seconds"
            }
          />
        )}

        {phase === "saving" && <FullScreenLoading text="Saving…" />}
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {phase === "naming" && (
        <SpeakerNamingPopup
          speakers={speakers}
          onSubmit={onSaveSpeakers}
          onSkip={() => onSaveSpeakers(
            speakers.map((s) => ({ speakerLabel: s.speakerLabel, displayName: null })),
            []
          )}
        />
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
      className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer ${
        consented
          ? "border-brand bg-brand/5"
          : "border-border bg-card"
      } ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
    >
      <input
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
