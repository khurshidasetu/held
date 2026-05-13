"use client";

import { useState, useTransition } from "react";
import {
  sendMeetingEmails,
  type SendEmailsResult,
} from "./actions";

type Props = {
  meetingId: string;
  attendees: string[];
};

export function SendEmailForm({ meetingId, attendees }: Props) {
  const [extra, setExtra] = useState("");
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(attendees.map((a) => [a, true]))
  );
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SendEmailsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const extraList = extra
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));

  const finalList = Array.from(
    new Set([
      ...attendees.filter((a) => included[a] !== false),
      ...extraList,
    ])
  );

  function send() {
    setError(null);
    setResult(null);
    startTransition(async () => {
      try {
        const r = await sendMeetingEmails(meetingId, finalList);
        setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Send failed");
      }
    });
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      {attendees.length > 0 && (
        <div>
          <div className="text-sm font-medium text-foreground mb-2">
            Attendees
          </div>
          <ul className="space-y-1">
            {attendees.map((a) => (
              <li key={a} className="flex items-center gap-2">
                <input
                  id={`att-${a}`}
                  type="checkbox"
                  checked={included[a] !== false}
                  onChange={(e) =>
                    setIncluded((m) => ({ ...m, [a]: e.target.checked }))
                  }
                  className="h-4 w-4 accent-brand"
                />
                <label htmlFor={`att-${a}`} className="text-sm">
                  {a}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <label
          htmlFor="extra"
          className="block text-sm font-medium text-foreground mb-1"
        >
          Add more recipients{" "}
          <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <input
          id="extra"
          type="text"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="someone@example.com, other@example.com"
          className="tap-target w-full px-3 py-2 rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-brand"
        />
      </div>

      {!confirming ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={finalList.length === 0}
          className="tap-target inline-flex items-center px-4 py-2 rounded-md bg-brand text-brand-foreground text-sm font-medium hover:bg-brand-hover disabled:opacity-40"
        >
          Send to {finalList.length || "…"}{" "}
          {finalList.length === 1 ? "recipient" : "recipients"}
        </button>
      ) : (
        <div className="rounded-md border border-border p-3 space-y-2">
          <div className="text-sm">
            We&rsquo;ll send the meeting notes to:
            <ul className="list-disc pl-5 mt-1">
              {finalList.map((r) => (
                <li key={r} className="text-muted-foreground">
                  {r}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={pending}
              className="tap-target px-3 py-1.5 rounded-md text-sm hover:bg-foreground/5"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={send}
              disabled={pending}
              className="tap-target px-3 py-1.5 rounded-md bg-brand text-brand-foreground text-sm font-medium hover:bg-brand-hover disabled:opacity-40"
            >
              {pending ? "Sending…" : "Confirm and send"}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300 px-3 py-2 text-sm">
          {error}
        </div>
      )}
      {result && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300 px-3 py-2 text-sm">
          Sent to {result.sent} of {result.sent + result.failed.length}.
          {result.failed.length > 0 && (
            <ul className="list-disc pl-5 mt-1">
              {result.failed.map((f) => (
                <li key={f.recipient}>
                  {f.recipient}: {f.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
