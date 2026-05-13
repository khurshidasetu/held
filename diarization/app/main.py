"""
Minutely diarization service.

Single endpoint:

  POST /diarize
    Headers: X-API-Key: <DIARIZATION_SERVICE_API_KEY>
    Body:    { "audio_url": "https://..." }
    200:     { "segments": [{ "speaker": "SPEAKER_00", "start": 0.0, "end": 3.4 }, ...] }

The service downloads `audio_url` to a temp file, runs pyannote.audio
speaker-diarization on it, and returns the segment list. The model is loaded
once at startup so subsequent requests do not pay the warm-up cost.

Authentication is a shared secret via the X-API-Key header. The Next.js web
app sends requests with this header set to env.diarization.apiKey.
"""

from __future__ import annotations

import logging
import os
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx
import torch
from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field
from pyannote.audio import Pipeline

LOG = logging.getLogger("minutely.diarization")
logging.basicConfig(level=logging.INFO)

# ── Configuration (env vars) ───────────────────────────────────────────────

API_KEY = os.environ.get("DIARIZATION_API_KEY")
if not API_KEY:
    raise RuntimeError(
        "DIARIZATION_API_KEY must be set. This is the shared secret the "
        "Next.js web app sends as X-API-Key."
    )

HF_TOKEN = os.environ.get("HUGGINGFACE_TOKEN")
if not HF_TOKEN:
    raise RuntimeError(
        "HUGGINGFACE_TOKEN must be set. pyannote/speaker-diarization-3.1 is "
        "gated — accept the terms at https://hf.co/pyannote/speaker-diarization-3.1 "
        "and pass a user-access token here."
    )

PIPELINE_NAME = os.environ.get(
    "DIARIZATION_PIPELINE", "pyannote/speaker-diarization-3.1"
)
# Hard cap on audio length to keep VPS memory bounded. Adjust if you ship to
# larger boxes; default ~3 hours is fine for typical meetings.
MAX_AUDIO_BYTES = int(os.environ.get("MAX_AUDIO_BYTES", str(500 * 1024 * 1024)))

# ── App state ──────────────────────────────────────────────────────────────


class AppState:
    pipeline: Pipeline | None = None


state = AppState()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    LOG.info("Loading pyannote pipeline: %s", PIPELINE_NAME)
    pipeline = Pipeline.from_pretrained(PIPELINE_NAME, use_auth_token=HF_TOKEN)

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


# ── Request/response models ────────────────────────────────────────────────


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
    """Stream the URL to a temp file and return its path. Bounded by MAX_AUDIO_BYTES."""
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


# ── Routes ─────────────────────────────────────────────────────────────────


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok" if state.pipeline is not None else "loading",
        "pipeline": PIPELINE_NAME,
        "gpu": "yes" if torch.cuda.is_available() else "no",
    }


@app.post("/diarize", response_model=DiarizeResponse)
async def diarize(
    req: DiarizeRequest,
    _: None = Depends(require_api_key),
) -> DiarizeResponse:
    if state.pipeline is None:
        raise HTTPException(status_code=503, detail="Pipeline not loaded yet.")

    audio_path = await _download(req.audio_url)
    try:
        # pyannote returns an Annotation; iterate tracks to get start/end and label.
        diarization = state.pipeline(str(audio_path))
        segments: list[Segment] = []
        for turn, _track, speaker in diarization.itertracks(yield_label=True):
            segments.append(
                Segment(speaker=str(speaker), start=float(turn.start), end=float(turn.end))
            )
        return DiarizeResponse(segments=segments)
    finally:
        try:
            audio_path.unlink(missing_ok=True)
        except OSError:
            LOG.exception("Failed to clean up %s", audio_path)
