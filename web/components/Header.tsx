import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

export function Header() {
  return (
    <header className="border-b border-border bg-background/80 backdrop-blur sticky top-0 z-30">
      <div className="max-w-5xl mx-auto flex items-center justify-between px-4 sm:px-6 h-14">
        <Link
          href="/app"
          className="flex items-center gap-2 font-semibold text-foreground"
        >
          <span className="w-6 h-6 rounded-md bg-brand text-brand-foreground inline-flex items-center justify-center text-xs font-bold">
            M
          </span>
          <span>Minutely</span>
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/app/meetings/new"
            className="tap-target hidden sm:inline-flex items-center px-3 py-1.5 rounded-md bg-brand text-brand-foreground text-sm font-medium hover:bg-brand-hover"
          >
            New meeting
          </Link>
          <UserButton />
        </div>
      </div>
    </header>
  );
}
