# CUDA-enabled base image, matching the project's actual GPU dependency
# (MedASR, MedGemma both require CUDA per Phases 9 and 13). Using
# nvidia/cuda's devel variant with cuDNN, not runtime-only, since some
# ML library installs need build tools available during pip install.
FROM nvidia/cuda:13.0.0-cudnn-devel-ubuntu24.04

# System dependencies: Python, ffmpeg (Phase 7's audio pipeline depends
# on ffmpeg/ffprobe as real subprocess calls, not a Python library),
# and build tools some ML packages need to compile against.
RUN apt-get update && apt-get install -y \
    python3.12 python3.12-venv python3-pip \
    ffmpeg \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first, separate from application code, so Docker's
# layer cache reuses the (very large -- torch, transformers, pyannote)
# dependency install across builds where only application code changed,
# not the dependency list. This matters a lot given how long this
# project's real dependency install has taken historically.
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

# Application code
COPY . .

# storage/ and logs/ are mounted as volumes at runtime (see docker-
# compose.prod.yml), not baked into the image -- audio files, PDFs, and
# logs must persist across container restarts/rebuilds, same principle
# as Postgres/Redis's existing named volumes since Phase 1.
RUN mkdir -p /app/storage /app/logs

EXPOSE 8000

# No --reload in production -- that's a dev-only uvicorn flag. Workers
# count of 1 is deliberate, not an oversight: this project's GPU model
# orchestrator (model_orchestrator.py) enforces a STRICT single-model-
# resident invariant on one GPU. Multiple worker PROCESSES would each
# try to manage their own independent GPU state, defeating that
# invariant entirely and risking exactly the VRAM contention the
# orchestrator exists to prevent. Scaling this service horizontally
# would need a fundamentally different GPU-sharing architecture, not
# just more uvicorn workers -- out of scope for this phase.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]