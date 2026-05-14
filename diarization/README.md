# Held · Diarization Service

A small FastAPI service that wraps [pyannote.audio](https://github.com/pyannote/pyannote-audio)
3.x for speaker diarization. The Held web app POSTs an audio URL here and
receives back a list of `{speaker, start, end}` segments.

## Endpoints

| Method | Path        | Auth                  | Description                                |
| ------ | ----------- | --------------------- | ------------------------------------------ |
| GET    | `/health`   | none                  | Returns `{status, pipeline, gpu}`.         |
| POST   | `/diarize`  | `X-API-Key` header    | Body: `{ "audio_url": "https://..." }` → `{ "segments": [...] }` |

## Local development (without GPU)

> Diarization on CPU is **slow** (10–30× realtime). Use this only for sanity
> checks. Real workloads need a GPU.

```bash
cd diarization
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# fill in DIARIZATION_API_KEY and HUGGINGFACE_TOKEN

export $(grep -v '^#' .env | xargs)
uvicorn app.main:app --reload --port 8000
```

Hit it:

```bash
curl http://localhost:8000/health

curl -X POST http://localhost:8000/diarize \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $DIARIZATION_API_KEY" \
  -d '{"audio_url":"https://example.com/some.wav"}'
```

## Deploying to a GPU VPS

Recommended providers: **Hetzner GPU**, **RunPod**, **Lambda Labs**,
**Vast.ai**. You need a single GPU with ≥ 8 GB VRAM (an RTX 3060/4060 is
plenty). The CUDA major version of the host must match the Docker base image
(`12.1` in our Dockerfile).

### 1. Accept the pyannote model terms

Diarization 3.1 is gated. While signed in to Hugging Face, accept the terms
on both pages — without this the model load will 401:

- https://hf.co/pyannote/speaker-diarization-3.1
- https://hf.co/pyannote/segmentation-3.0

Then create a token at https://huggingface.co/settings/tokens (read access
is enough).

### 2. Install Docker + the NVIDIA container toolkit on the VPS

For Ubuntu 22.04:

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# NVIDIA toolkit
distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker

# Sanity check
docker run --rm --gpus all nvidia/cuda:12.1.1-base-ubuntu22.04 nvidia-smi
```

### 3. Build and run

```bash
git clone <your-fork-of-minutely>
cd minutely/diarization

cp .env.example .env
# fill in DIARIZATION_API_KEY and HUGGINGFACE_TOKEN

docker build -t minutely-diarization .

# Persist the model cache across container restarts so we don't re-download
# the ~1 GB of pyannote weights on every deploy.
docker volume create minutely-hf-cache

docker run -d \
  --name minutely-diarization \
  --gpus all \
  --restart unless-stopped \
  -p 8000:8000 \
  --env-file .env \
  -v minutely-hf-cache:/root/.cache/huggingface \
  minutely-diarization
```

### 4. (Recommended) Put it behind TLS

Run nginx or Caddy on the host, terminating TLS on port 443 and proxying to
`127.0.0.1:8000`. Then in the Held web app set
`DIARIZATION_SERVICE_URL=https://diarize.example.com`.

### 5. (Recommended) Lock down the firewall

Only the Held web server should be able to reach port 443 (or 8000
directly). Even with `X-API-Key` as defence-in-depth, restrict at the network
layer:

```bash
sudo ufw default deny incoming
sudo ufw allow ssh
sudo ufw allow from <your-web-app-egress-ip> to any port 443
sudo ufw enable
```

## Troubleshooting

- **`OSError: ... is not a local folder and is not a valid model identifier`**:
  The `HUGGINGFACE_TOKEN` is missing/invalid, or the pyannote terms weren't
  accepted on Hugging Face.
- **`Could not connect to GPU`**: NVIDIA toolkit not installed or
  `nvidia-ctk runtime configure --runtime=docker` not run.
- **OOM on long audio**: Lower `MAX_AUDIO_BYTES`, or rent a bigger GPU.
- **First request slow, then fast**: Normal — pyannote does GPU warmup on the
  first inference. Health-check is good but doesn't warm the GPU; consider
  hitting `/diarize` once with a tiny clip after start.
