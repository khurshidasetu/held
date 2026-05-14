import type { Metadata, Viewport } from "next";
import { Fraunces, EB_Garamond, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

// Fraunces — primary face. Variable axes for weight, italic, and optical
// size. next/font self-hosts it under /_next/static (no runtime Google
// Fonts request).
const fraunces = Fraunces({
  variable: "--font-serif",
  subsets: ["latin"],
  axes: ["opsz"],
  display: "swap",
});

// EB Garamond — kept loaded as a secondary serif. Available under
// --font-eb-garamond if/when we want to differentiate (e.g. running text
// in long passages vs. display).
const ebGaramond = EB_Garamond({
  variable: "--font-eb-garamond",
  subsets: ["latin"],
  display: "swap",
});

// Geist Mono is kept just for the recorder timer (tabular nums look better
// in a monospace face than in a serif).
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
  icons: {
    icon: "/favicon.ico",
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
    <ClerkProvider afterSignOutUrl="/">
      <html
        lang="en"
        className={`${fraunces.variable} ${ebGaramond.variable} ${geistMono.variable} h-full antialiased`}
        suppressHydrationWarning
      >
        <head>
          <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        </head>
        <body className="min-h-full flex flex-col">{children}</body>
      </html>
    </ClerkProvider>
  );
}
