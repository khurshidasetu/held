# CUDA 12.1 + Python 3.11 base. Torch 2.4 wheels target CUDA 12.1, so this
# matches the requirements.txt pin. If your host has a different CUDA major,
# rebuild with the matching nvidia/cuda tag and bump torch accordingly.
FROM nvidia/cuda:12.1.1-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/root/.cache/huggingface \
    TORCH_HOME=/root/.cache/torch

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-venv \
        python3-pip \
        ffmpeg \
        ca-certificates \
        curl \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python

WORKDIR /app

# Install torch/torchaudio from the cu121 wheel index first so pyannote
# (installed next, from requirements.txt) doesn't pull CPU variants.
RUN python -m pip install --upgrade pip \
    && pip install --index-url https://download.pytorch.org/whl/cu121 \
        torch==2.4.1 torchaudio==2.4.1

COPY requirements.txt /app/requirements.txt
RUN pip install -r requirements.txt

COPY app /app/app

EXPOSE 8000

# Single worker — the pyannote pipeline is heavy; scale horizontally with more
# containers rather than uvicorn workers in the same process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
