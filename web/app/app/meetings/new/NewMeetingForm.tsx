"use client";

import { useState } from "react";
import { Recorder } from "@/components/Recorder";

export function NewMeetingForm() {
  const [title, setTitle] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [emails, setEmails] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  function addEmail(raw: string) {
    const cleaned = raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
    if (cleaned.length === 0) return;
    setEmails((prev) => Array.from(new Set([...prev, ...cleaned])));
    setEmailInput("");
  }

  function removeEmail(e: string) {
    setEmails((prev) => prev.filter((x) => x !== e));
  }

  if (ready) {
    return <Recorder meetingTitle={title.trim()} attendeeEmails={emails} />;
  }

  const canProceed = title.trim().length > 0;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canProceed) setReady(true);
      }}
      className="space-y-4"
    >
      <div>
        <label
          htmlFor="title"
          className="block text-sm font-medium text-foreground mb-1"
        >
          Title
        </label>
        <input
          id="title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Weekly product sync"
          required
          className="tap-target w-full px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </div>

      <div>
        <label
          htmlFor="emails"
          className="block text-sm font-medium text-foreground mb-1"
        >
          Attendee emails{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <input
          id="emails"
          type="text"
          value={emailInput}
          onChange={(e) => setEmailInput(e.target.value)}
          onBlur={() => emailInput && addEmail(emailInput)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addEmail(emailInput);
            }
          }}
          placeholder="sarah@example.com, mike@example.com"
          className="tap-target w-full px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-brand"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Press Enter, comma, or space to add. These people will appear on the
          email recipient list after the meeting.
        </p>
        {emails.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {emails.map((e) => (
              <span
                key={e}
                className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-brand/10 text-brand text-xs font-medium"
              >
                {e}
                <button
                  type="button"
                  onClick={() => removeEmail(e)}
                  aria-label={`Remove ${e}`}
                  className="tap-target w-6 h-6 inline-flex items-center justify-center rounded-full hover:bg-brand/20"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        type="submit"
        disabled={!canProceed}
        className="tap-target w-full inline-flex items-center justify-center px-4 py-3 rounded-md bg-brand text-brand-foreground font-medium hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Continue to recording
      </button>
    </form>
  );
}
