# PWA icons

The manifest references four PNG icons here; they are **not yet committed**.
Before shipping to production, drop in:

| File                  | Size      | Purpose          |
| --------------------- | --------- | ---------------- |
| `icon-192.png`        | 192×192   | Standard         |
| `icon-512.png`        | 512×512   | Standard         |
| `maskable-512.png`    | 512×512   | Maskable (Android adaptive icons — keep the logo inside the inner 80% safe zone) |
| `apple-touch-icon.png`| 180×180   | iOS home-screen  |

Brand color is `#4f46e5` (indigo-600). A simple approach: white "M" on a solid
indigo background, with the maskable variant adding extra padding.

You can generate all four from a single 1024×1024 source PNG using a tool
like https://realfavicongenerator.net or `pwa-asset-generator`.
