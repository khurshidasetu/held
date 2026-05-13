"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function MeetingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Meeting page error:", error);
  }, [error]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-300 p-6">
        <div className="font-semibold mb-1">Something went wrong.</div>
        <p className="text-sm">
          We couldn&rsquo;t load this meeting. Try again, or head back to your
          dashboard.
        </p>
        {error.message && (
          <p className="mt-2 text-xs opacity-70 break-words">{error.message}</p>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="tap-target px-4 py-2 rounded-md border border-border text-sm hover:bg-foreground/5"
        >
          Try again
        </button>
        <Link
          href="/app"
          className="tap-target px-4 py-2 rounded-md bg-brand text-brand-foreground text-sm font-medium hover:bg-brand-hover"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
