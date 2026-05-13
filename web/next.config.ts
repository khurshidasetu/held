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

const withPWAConfig = withPWA({
  dest: "public",
  // Disable in dev — the SW caches aggressively and gets in the way of HMR.
  disable: isDev,
  register: true,
  // Auto-skip waiting so an updated SW takes over without a forced reload.
  workboxOptions: {
    skipWaiting: true,
    clientsClaim: true,
  },
});

export default withPWAConfig(nextConfig);
