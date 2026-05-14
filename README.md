# Minutely

> Minutely — meeting capture with speaker identification, transcription, and AI summaries.

*Get every meeting Minutely.*

Minutely is a Progressive Web App that records a meeting in the browser,
identifies each speaker, lets the user name them with audio samples to verify,
transcribes the conversation, generates an AI summary with action items and
key topics, and emails the result to attendees plus any extra recipients.
Works on desktop and on mobile (Chrome on Android, Safari on iOS).

## Architecture

Two services in one repository:

```
minutely/
├── web/            Next.js 16 PWA (App Router, TypeScript, Tailwind)
│                   - Clerk auth, MySQL + Drizzle, AWS S3
│                   - Cartesia Ink-Whisper for streaming STT
│                   - Claude Sonnet 4.5 for summaries
│                   - Postmark for transactional email
│                   - Server-side ffmpeg via fluent-ffmpeg
│
└── diarization/    FastAPI service (Python 3.11, pyannote.audio 3.x)
                    - One endpoint: POST /diarize
                    - Designed for a GPU VPS (Hetzner, RunPod, Lambda)
                    - Dockerfile + deploy guide in diarization/README.md
```

### How a meeting flows through the system

1. User signs in (**Clerk**).
2. User creates a meeting: title + optional attendee emails.
3. **Consent gate** — the user must explicitly check
   *"All participants have consented to being recorded"* before the Record
   button enables. (Legally required; not skippable.)
4. **MediaRecorder** captures audio in the browser. iOS Safari falls back to
   `audio/mp4` when `audio/webm` is unsupported.
5. On Stop, the audio is uploaded to **S3** (`meetings/{id}/audio.{ext}`) and
   a row is created in MySQL with status `awaiting_speaker_naming`.
6. The web server calls the **diarization service** with a presigned URL.
   pyannote returns `[{ speaker, start, end }]`. The web server uses
   `fluent-ffmpeg` to slice the **first clear segment ≥ 2 s** (capped at 8 s)
   per speaker, uploads each clip to `speaker-samples/{meeting_id}/`, and
   returns the speaker list to the client.
7. **Speaker Naming Popup** shows. The user plays each sample, types a name,
   and can add silent attendees (people who joined but didn't speak).
8. On Continue, the names are saved and the meeting transitions to
   `processing`. A fire-and-forget request kicks off the pipeline:
   - **Cartesia Ink-Whisper** transcribes the audio (PCM streamed over WS).
   - Word timestamps are merged with the cached diarization segments to
     produce `"Sarah: ..."` style utterances.
   - **Claude Sonnet 4.5** generates summary + action items + decisions + topics.
   - Status → `complete`.
9. The meeting detail page shows the named transcript and structured summary.
10. **Send to attendees** ships per-recipient emails through **Postmark**, with
    subject `[Minutely] Notes from "{meeting_title}"`.

## Running locally

### Prerequisites

- Node.js **20.9+**
- Python **3.11+**
- An AWS S3 bucket (private; presigned URLs handle all reads)
- A MySQL 8.0+ database (local Docker is fine for dev)
- Accounts at Clerk, Cartesia, Anthropic, Postmark, and Hugging Face
- For diarization in production: a GPU VPS (see `diarization/README.md`)

### 1. MySQL via Docker Compose

A `docker-compose.yml` at the repo root spins up MySQL 8 with the Minutely
schema and an application user pre-configured. From the repo root:

```bash
docker compose up -d           # builds infra/mysql/Dockerfile, starts the container
docker compose ps              # should show "healthy" after ~10–20s
docker compose logs -f mysql   # tail the log if anything looks off
```

The image source lives in [`infra/mysql/`](./infra/mysql/):
- `Dockerfile` — extends `mysql:8.0`, copies in our config + init scripts
- `my.cnf` — utf8mb4 everywhere, UTC time zone, strict SQL mode
- `init/01-init.sql` — creates the `minutely` app user on first start

Default credentials (override via env if needed):
- Database: `minutely`
- Root: `root` / `root` (use this for `DATABASE_URL` in `.env.local`)
- App user: `minutely` / `minutely`
- Port: `127.0.0.1:3306` (bound to loopback only)

Data persists in the named volume `minutely-mysql-data`. `docker compose down`
keeps your data; `docker compose down -v` wipes it.

If you'd rather use a hosted MySQL (PlanetScale, Railway, AWS RDS, etc.),
skip the compose step and just point `DATABASE_URL` at it — any
`mysql://user:pass@host:port/db` works.

### 2. Web app

```bash
cd web
cp .env.example .env.local
# fill in every variable; the app throws loudly if any are missing
npm install --legacy-peer-deps
npm run db:push        # apply Drizzle schema to MySQL
npm run dev            # http://localhost:3000
```

### 3. Diarization service

The full deploy story (Docker + GPU + Hugging Face terms) is in
[`diarization/README.md`](./diarization/README.md). For sanity-checking the
wire format on a development laptop without a GPU:

```bash
cd diarization
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# fill in DIARIZATION_API_KEY (echo this into web/.env.local too) and
# HUGGINGFACE_TOKEN
export $(grep -v '^#' .env | xargs)
uvicorn app.main:app --reload --port 8000
```

Then in `web/.env.local`:
```env
DIARIZATION_SERVICE_URL="http://localhost:8000"
DIARIZATION_SERVICE_API_KEY="<the same value>"
```

> CPU diarization is **slow** (a 5-minute clip can take several minutes).
> For development, record very short clips, or stub the service.

## Environment variables

The full list with descriptions is in
[`web/.env.example`](./web/.env.example) and
[`diarization/.env.example`](./diarization/.env.example). Briefly:

**Web app (`web/.env.local`)**

| Group        | Vars                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| App          | `NEXT_PUBLIC_APP_URL`                                                              |
| DB           | `DATABASE_URL` (MySQL connection string)                                            |
| Auth         | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, redirect URLs              |
| Storage      | `AWS_REGION`, `AWS_S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`         |
| Diarization  | `DIARIZATION_SERVICE_URL`, `DIARIZATION_SERVICE_API_KEY`                           |
| STT          | `CARTESIA_API_KEY`                                                                  |
| LLM          | `ANTHROPIC_API_KEY`                                                                 |
| Email        | `POSTMARK_SERVER_TOKEN`, `POSTMARK_FROM_EMAIL`, `POSTMARK_FROM_NAME`               |
| Internal     | `INTERNAL_WORKER_SECRET`                                                            |

**Diarization service (`diarization/.env`)**

| Var                     | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `DIARIZATION_API_KEY`   | Shared secret. Must match the web app's `DIARIZATION_SERVICE_API_KEY`. |
| `HUGGINGFACE_TOKEN`     | Required to pull the gated pyannote model.                    |

## Database schema (Drizzle)

Defined in [`web/db/schema.ts`](./web/db/schema.ts). Tables:

- `meetings` — title, audio_url, duration, status enum, cached diarization
- `attendees` — emails entered when creating the meeting
- `speakers` — both detected (with `sample_audio_url`) and silent attendees
- `transcript_segments` — final named utterances (speaker_id FK)
- `meeting_summaries` — summary text + action_items / decisions / topics (jsonb)
- `email_sends` — per-recipient Postmark sends

Run migrations:

```bash
cd web
npm run db:generate    # creates a SQL migration in ./drizzle/
npm run db:migrate     # applies it
# or, for fast iteration:
npm run db:push        # diffs schema → DB directly
```

## Next.js 16 notes

This project targets **Next.js 16**, which has breaking changes from 15. The
ones that matter here:

- **`middleware.ts` → `proxy.ts`** at the project root. Clerk's auth gate is
  configured in `web/proxy.ts`. The `proxy` runtime is Node.js (not Edge).
- **Async request APIs**: `cookies()`, `headers()`, `params`, and
  `searchParams` are Promises with no sync fallback. All route handlers
  `await ctx.params`.
- **Turbopack default** for `dev` and `build`. No webpack config required.

The bundled docs at `web/node_modules/next/dist/docs/` are the authoritative
reference; `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`
covers every change.

## License

Source-available; private project.
