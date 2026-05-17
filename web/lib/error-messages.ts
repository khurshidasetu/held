/**
 * Translate raw pipeline-failure strings (the stuff stored in
 * meetings.error_message) into a friendly heading + body + hint
 * that an end user can actually act on.
 *
 * Why: the raw values are upstream service responses — JSON payloads,
 * status codes, ffmpeg complaints, OpenRouter API errors. Useful for
 * debugging from logs but unhelpful to a user staring at the meeting
 * detail page wondering what to do next.
 *
 * Design:
 *   - heading: short, headline-style. "We couldn't read your recording."
 *   - body:    one sentence saying what actually went wrong, in plain
 *              language (NOT what the service returned verbatim).
 *   - hint:    optional one-liner with the next step the user can try.
 *   - technical: the raw upstream message, surfaced in a collapsible
 *                "Technical details" disclosure for support / dev triage.
 *                Never thrown away — just hidden by default.
 *
 * Matching order matters: more specific patterns (e.g. the exact
 * pyannote "could not probe audio duration" string) are checked before
 * generic catch-alls (anything mentioning "diarization"). Each branch
 * has a short comment explaining what real-world failure it covers.
 */

export type FriendlyMeetingError = {
  heading: string;
  body: string;
  hint?: string;
  /** Raw upstream message; preserved for the "Technical details" toggle. */
  technical: string;
};

export function humanizeMeetingError(
  raw: string | null | undefined
): FriendlyMeetingError {
  const message = (raw ?? "").trim();

  if (!message) {
    return {
      heading: "Something went wrong",
      body: "We couldn't finish processing this meeting and don't have a clear reason why.",
      hint: "Try recording again. If it keeps failing, let support know.",
      technical: "",
    };
  }

  const lower = message.toLowerCase();

  // ── Diarization failures ─────────────────────────────────────────────

  // pyannote / ffprobe couldn't determine how long the audio is. Almost
  // always: the recording is empty, was cut off before any audio was
  // captured, or the container is malformed.
  if (
    lower.includes("could not probe audio duration") ||
    lower.includes("no duration found")
  ) {
    return {
      heading: "We couldn't read your recording",
      body: "The audio file appears to be empty or in an unsupported format.",
      hint: "Check that the microphone captured sound this time, then record again. Very short clips (under one second) can also trigger this.",
      technical: message,
    };
  }

  // Diarization ran but emitted no segments — the audio was silent or
  // below the VAD floor.
  if (lower.includes("no speech detected")) {
    return {
      heading: "We couldn't hear any speech",
      body: "The recording was processed, but no voices were detected.",
      hint: "Make sure your microphone is unmuted and there's audible speech in the recording, then try again.",
      technical: message,
    };
  }

  // Diarization service unreachable / crashed.
  if (
    lower.includes("diarization") &&
    (lower.includes("500") ||
      lower.includes("internal server error") ||
      lower.includes("502") ||
      lower.includes("503") ||
      lower.includes("504"))
  ) {
    return {
      heading: "Speaker detection hit an error",
      body: "Our speaker-detection service had a problem with this recording.",
      hint: "Wait a minute and try again. If it keeps failing, the recording may be corrupted — try a fresh one.",
      technical: message,
    };
  }

  // Anything else from diarization (e.g. 4xx other than the duration one).
  if (lower.includes("diarization")) {
    return {
      heading: "Speaker detection couldn't process this recording",
      body: "Our speaker-detection service wasn't able to handle the audio.",
      hint: "The file may be corrupted or in an unsupported format. Try recording again.",
      technical: message,
    };
  }

  // ── LLM / summary failures (OpenRouter, Anthropic, etc.) ─────────────

  // OpenRouter 402 — out of credits / token budget mismatch.
  if (
    lower.includes("openrouter 402") ||
    lower.includes("requires more credits") ||
    lower.includes("fewer max_tokens")
  ) {
    return {
      heading: "Summary couldn't be generated",
      body: "Our AI service is temporarily out of credits.",
      hint: "Please try again later. If this keeps happening, let support know — the account needs a top-up.",
      technical: message,
    };
  }

  // OpenRouter 404 with the guardrail / data-policy message (the
  // account-level privacy preset the team is still working through).
  if (
    (lower.includes("openrouter") && lower.includes("404")) ||
    lower.includes("no endpoints available") ||
    lower.includes("guardrail restrictions") ||
    lower.includes("data policy")
  ) {
    return {
      heading: "Summary couldn't be generated",
      body: "Our AI service rejected the request due to account privacy settings.",
      hint: "This needs to be fixed at the account level — please contact support.",
      technical: message,
    };
  }

  // OpenRouter auth failures.
  if (
    lower.includes("openrouter") &&
    (lower.includes("401") || lower.includes("403"))
  ) {
    return {
      heading: "Summary couldn't be generated",
      body: "Our AI service authentication failed.",
      hint: "Please contact support — the API key may need to be refreshed.",
      technical: message,
    };
  }

  // Generic OpenRouter / Claude error.
  if (
    lower.includes("openrouter") ||
    lower.includes("anthropic") ||
    lower.includes("claude")
  ) {
    return {
      heading: "Summary couldn't be generated",
      body: "Our AI service had a problem producing the meeting summary.",
      hint: "Try again in a moment. The recording and transcript are saved either way.",
      technical: message,
    };
  }

  // LLM JSON parsing / schema validation failed (rare — usually a model
  // outage producing garbled output).
  if (
    lower.includes("llm response was not valid json") ||
    lower.includes("zoderror") ||
    lower.includes("schema")
  ) {
    return {
      heading: "Summary couldn't be generated",
      body: "Our AI returned a response we couldn't parse.",
      hint: "Try again — this is usually a transient model issue.",
      technical: message,
    };
  }

  // ── STT failures ─────────────────────────────────────────────────────

  if (
    lower.includes("cartesia") ||
    lower.includes(" stt ") ||
    lower.includes("transcrib") ||
    lower.includes("websocket")
  ) {
    return {
      heading: "Speech-to-text failed",
      body: "We couldn't convert the audio into text.",
      hint: "The recording may be too noisy or in an unsupported format. Try again.",
      technical: message,
    };
  }

  // ── Catch-all ────────────────────────────────────────────────────────

  return {
    heading: "Processing failed",
    body: "Something went wrong while processing your meeting.",
    hint: "Try recording again. If it keeps failing, let support know.",
    technical: message,
  };
}
