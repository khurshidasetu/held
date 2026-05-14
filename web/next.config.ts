import type { NextConfig } from "next";
import withPWA from "@ducanh2912/next-pwa";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // ffmpeg and the ffmpeg-installer binary must stay external to the
  // server bundle so Node can require() the platform-native binary at runtime.
  serverExternalPackages: ["fluent-ffmpeg", "@ffmpeg-installer/ffmpeg"],

  images: {
    // Allow next/image to optimize anything we serve from our own S3 bucket
    // (presigned URLs only — bucket is private at the object level).
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.s3.amazonaws.com",
      },
      {
        protocol: "https",
        hostname: "*.s3.*.amazonaws.com",
      },
    ],
  },
};

const isDev = process.env.NODE_ENV === "development";

// `@ducanh2912/next-pwa` is a webpack plugin. Even with `disable: true` it
// injects a webpack hook that Next 16's Turbopack-default mode rejects. So
// in dev we ship nextConfig as-is (no SW anyway), and only wrap with the PWA
// HOC for production builds. The production build script already passes
// `--webpack`, so the conflict doesn't arise there.
const withPWAConfig = withPWA({
  dest: "public",
  disable: isDev,
  register: true,
  workboxOptions: {
    skipWaiting: true,
    clientsClaim: true,
  },
});

export default isDev ? nextConfig : withPWAConfig(nextConfig);
