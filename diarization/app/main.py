"""
Minutely diarization service.

Two modes, selected via DIARIZATION_MODE env var:

  - "real"  → pyannote.audio 3.1 (requires HUGGINGFACE_TOKEN + accepted terms,
              and torch installed via Dockerfile.cpu or Dockerfile).
  - "mock"  → returns synthetic speaker segments based on the real audio
              duration. No HF account, no torch, no GPU. Use this for local
              dev when you don't want the full ML stack.

Both modes expose the same endpoint:

  POST /diarize
    Headers: X-API-Key: <DIARIZATION_SERVICE_API_KEY>
    Body:    { "audio_url": "<presigned URL>" }
    200:     { "segments": [{ "speaker": "SPEAKER_00", "start": 0.0, "end": 3.4 }, ...] }

The wire format is identical, so switching modes is a one-env-var flip and
the web app needs no changes.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field

LOG = logging.getLogger("minutely.diarization")
logging.basicConfig(level=logging.INFO)

# ── Configuration ─────────────────────────────────────────────────────────

API_KEY = os.environ.get("DIARIZATION_API_KEY")
if not API_KEY:
    raise RuntimeError(
        "DIARIZATION_API_KEY must be set. This is the shared secret the "
        "Next.js web app sends as X-API-Key."
    )

MODE = os.environ.get("DIARIZATION_MODE", "real").lower()
if MODE not in ("real", "mock"):
    raise RuntimeError(f"Invalid DIARIZATION_MODE: {MODE!r} (expected 'real' or 'mock')")

# Hard cap on audio length to keep memory bounded. Default ~500 MB is plenty
# for typical meetings.
MAX_AUDIO_BYTES = int(os.environ.get("MAX_AUDIO_BYTES", str(500 * 1024 * 1024)))

# Mock-mode tunables. Real meetings have natural turn-taking around 4–8 s;
# we synthesize alternating speakers in that range.
MOCK_TURN_SECONDS = float(os.environ.get("MOCK_TURN_SECONDS", "5.0"))
MOCK_MAX_SPEAKERS = int(os.environ.get("MOCK_MAX_SPEAKERS", "2"))


# ── App state ──────────────────────────────────────────────────────────────


class AppState:
    pipeline: object | None = None  # pyannote pipeline, only in real mode


state = AppState()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    if MODE == "mock":
        LOG.info("Starting in MOCK mode — synthetic segments, no ML.")
        state.pipeline = None
        yield
        return

    # Real mode — heavy imports stay inside this branch so the mock image
    # doesn't need torch/pyannote installed.
    LOG.info("Starting in REAL mode — loading pyannote pipeline.")
    hf_token = os.environ.get("HUGGINGFACE_TOKEN")
    if not hf_token:
        raise RuntimeError(
            "HUGGINGFACE_TOKEN is required in real mode. Set DIARIZATION_MODE=mock "
            "to skip this, or fetch a token from https://huggingface.co/settings/tokens "
            "after accepting the pyannote-3.1 model terms."
        )
    pipeline_name = os.environ.get(
        "DIARIZATION_PIPELINE", "pyannote/speaker-diarization-3.1"
    )

    import torch  # type: ignore[import-not-found]
    from pyannote.audio import Pipeline  # type: ignore[import-not-found]

    pipeline = Pipeline.from_pretrained(pipeline_name, use_auth_token=hf_token)
    if torch.cuda.is_available():
        LOG.info("CUDA available — moving pipeline to GPU.")
        pipeline.to(torch.device("cuda"))
    else:
        LOG.info("No CUDA — running on CPU. This will be slow.")
    state.pipeline = pipeline
    LOG.info("Pipeline ready.")
    yield
    state.pipeline = None


app = FastAPI(title="Minutely Diarization", version="0.1.0", lifespan=lifespan)


# ── Auth ───────────────────────────────────────────────────────────────────


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    if x_api_key != API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-API-Key.",
        )


# ── Models ─────────────────────────────────────────────────────────────────


class DiarizeRequest(BaseModel):
    audio_url: str = Field(
        ..., description="HTTPS URL the service can fetch the audio file from."
    )


class Segment(BaseModel):
    speaker: str
    start: float
    end: float


class DiarizeResponse(BaseModel):
    segments: list[Segment]


# ── Helpers ────────────────────────────────────────────────────────────────


async def _download(url: str) -> Path:
    """Stream the URL to a temp file. Bounded by MAX_AUDIO_BYTES."""
    fd, tmp = tempfile.mkstemp(prefix=f"minutely-{uuid.uuid4().hex}-")
    os.close(fd)
    path = Path(tmp)

    total = 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        async with client.stream("GET", url) as resp:
            if resp.status_code != 200:
                path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to fetch audio_url: HTTP {resp.status_code}",
                )
            with path.open("wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=64 * 1024):
                    total += len(chunk)
                    if total > MAX_AUDIO_BYTES:
                        path.unlink(missing_ok=True)
                        raise HTTPException(
                            status_code=413,
                            detail=f"Audio exceeds {MAX_AUDIO_BYTES} bytes.",
                        )
                    f.write(chunk)
    return path


def _probe_duration_seconds(path: Path) -> float:
    """Return the audio duration in seconds via ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
        data = json.loads(result.stdout)
        return float(data["format"]["duration"])
    except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError, ValueError) as e:
        raise HTTPException(
            status_code=422, detail=f"Could not probe audio duration: {e}"
        )


def _mock_segments(duration: float) -> list[Segment]:
    """
    Synthesize speaker turns of MOCK_TURN_SECONDS, alternating across
    MOCK_MAX_SPEAKERS. Always at least one segment.

    Each speaker is guaranteed to get a segment of ≥ MOCK_TURN_SECONDS where
    possible, so the web app's sample-extraction logic ("first segment ≥ 2 s")
    has good material to slice. For very short audio we collapse to a single
    speaker for the whole duration.
    """
    if duration <= 0:
        return []
    if duration < MOCK_TURN_SECONDS * 1.5:
        # Too short to credibly fake multiple speakers.
        return [Segment(speaker="SPEAKER_00", start=0.0, end=duration)]

    segments: list[Segment] = []
    t = 0.0
    i = 0
    while t < duration:
        end = min(t + MOCK_TURN_SECONDS, duration)
        speaker_idx = i % MOCK_MAX_SPEAKERS
        segments.append(
            Segment(speaker=f"SPEAKER_{speaker_idx:02d}", start=t, end=end)
        )
        t = end
        i += 1
    return segments


# ── Routes ─────────────────────────────────────────────────────────────────


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "mode": MODE,
        "pipeline_loaded": "yes" if state.pipeline is not None else "no",
    }


@app.post("/diarize", response_model=DiarizeResponse)
async def diarize(
    req: DiarizeRequest,
    _: None = Depends(require_api_key),
) -> DiarizeResponse:
    audio_path = await _download(req.audio_url)
    try:
        if MODE == "mock":
            duration = _probe_duration_seconds(audio_path)
            LOG.info("mock diarize: duration=%.2fs", duration)
            return DiarizeResponse(segments=_mock_segments(duration))

        # Real mode
        if state.pipeline is None:
            raise HTTPException(status_code=503, detail="Pipeline not loaded yet.")
        diarization = state.pipeline(str(audio_path))  # type: ignore[operator]
        segments: list[Segment] = []
        for turn, _track, speaker in diarization.itertracks(yield_label=True):
            segments.append(
                Segment(
                    speaker=str(speaker),
                    start=float(turn.start),
                    end=float(turn.end),
                )
            )
        return DiarizeResponse(segments=segments)
    finally:
        try:
            audio_path.unlink(missing_ok=True)
        except OSError:
            LOG.exception("Failed to clean up %s", audio_path)
