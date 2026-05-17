import type { Metadata, Viewport } from "next";
import { Open_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";

// Open Sans — primary face for the whole app. Loaded via next/font so
// it's self-hosted under /_next/static (no runtime Google Fonts request,
// no FOIT). We pull the full weight range as a variable font; italics
// are bundled in the same variable so emphasised text works without a
// second download.
const openSans = Open_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

// Geist Mono — kept for the recorder timer + tabular numerics in the
// transcript / "Working for Xs..." counters. Monospace digits prevent
// the layout from jiggling as the count updates.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Held — Every meeting, held for you.",
  description:
    "Held ships the answer, not a transcript. Decisions, action items, open questions, and the next step in one card.",
  applicationName: "Held",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "Held",
    statusBarStyle: "default",
  },
  // `app/icon.png` is auto-detected by Next.js and emits the
  // <link rel="icon"> tag for us, so we only need to declare the
  // Apple touch icon explicitly here.
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#4f46e5",
  width: "device-width",
  initialScale: 1,
  // PWA on iOS respects this for the status-bar / safe-area treatment.
  viewportFit: "cover",
};

// Inline so it runs *before* React hydration → no light-mode flash for
// users who have opted into dark. Default is light; only switches if the
// user's stored preference is "dark".
const themeBootstrap = `(function(){try{var t=localStorage.getItem('held:theme');if(t==='dark')document.documentElement.classList.add('dark');}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${openSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
      </head>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
