# MedSTT Deployment Runbook

This runbook documents the production deployment path actually built and tested
in Phase 17. Every step below reflects a real, verified command from that
testing — not a generic template. Where something is a known, real limitation of
this deployment, it's stated plainly rather than glossed over.

## 1. Prerequisites

### Hardware
- A GPU with at least 8GB VRAM is a **hard requirement**, not a recommendation.
  MedASR (Phase 9) and MedGemma (Phase 13) both require CUDA, and MedGemma alone
  was measured using ~6.2GB VRAM even in isolation with partial CPU offload
  already occurring at that size — see PROJECT_STATUS.md's Phase 13 notes.
  Anything smaller than 8GB VRAM is not expected to run this system's ML pipeline
  successfully.
- Minimum 16GB system RAM recommended. The original development environment ran
  on ~6GB and worked, but that required careful sequencing (never running
  chunking/diarization and NER simultaneously, for example) — a production
  deployment serving real concurrent load should not assume that same discipline
  is being manually applied by an operator.

### Software
- Docker Engine with Docker Compose v2 (the `!reset`/`!override` YAML merge
  directives used in `docker-compose.prod.yml` require a reasonably current
  Compose version — verify with `docker compose version`).
- **NVIDIA Container Toolkit** installed on the host — this is what makes
  `docker run --gpus all` (and the equivalent `deploy.resources.reservations`
  block in the prod compose file) actually work. Verify with:
  ```
  docker run --rm --gpus all nvidia/cuda:13.0.0-cudnn-devel-ubuntu24.04 nvidia-smi
  ```
  This should show your real GPU. If this fails, the Container Toolkit is not
  correctly installed — this project's backend container will not be able to
  reach the GPU at all until this is fixed, and every ML pipeline call will fail.
- A real domain name and TLS certificate for production use. **This project does
  not configure HTTPS/TLS termination anywhere** (see Section 5, Known
  Limitations) — a reverse proxy (nginx, Caddy, or a cloud load balancer) must
  sit in front of this stack and terminate TLS before traffic reaches the
  frontend/backend containers.

## 2. First-Time Deployment

### 2.1 Clone the repository and set up environment variables

```bash
git clone <your-repo-url> medstt
cd medstt
cp .env.example .env
```

Edit `.env` with real production values. At minimum, the following **must** be
changed from their dev defaults before going live:

| Variable | Dev default | Production requirement |
|---|---|---|
| `POSTGRES_PASSWORD` | dev placeholder | strong, unique secret |
| `REDIS_PASSWORD` | dev placeholder | strong, unique secret |
| `COOKIE_SECURE` | `False` | `True` — **only works if HTTPS is actually in place first** (see 2.4) |
| `CORS_ALLOWED_ORIGINS` | `http://localhost:5173` | your real frontend domain, e.g. `https://medstt.yourdomain.gov` |
| `HUGGINGFACE_TOKEN` | your dev token | a real token with access to `google/medasr`, `pyannote/segmentation-3.0`, `pyannote/speaker-diarization-3.1`, `google/medgemma-1.5-4b-it` (all four require accepting license terms on huggingface.co beforehand, per Phases 8, 9, and 13) |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | — | optional (see Section 5) — leave blank to run without cloud ASR consensus |
| `VITE_API_BASE_URL` (used at frontend **build** time, not runtime) | `http://localhost:8000` | your real backend URL |

### 2.2 Build and start the stack

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

**Real timing expectation, not a guess:** the backend image build took
approximately **2 hours** in Phase 17 testing, due to the CUDA base image plus
the full ML dependency stack (torch, transformers, pyannote, etc.). The frontend
build took under 3 minutes. Budget for the backend build time accordingly —
this is not a quick `docker compose up` the first time.

### 2.3 Verify health

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
curl http://localhost:8000/health/ready
```

All services should show healthy/running, with **no `pgadmin` container** (it is
explicitly removed in the production profile — see `docker-compose.prod.yml`'s
`!reset null` override). `/health/ready` verifies real Postgres and Redis
connectivity, not just process liveness (per the liveness/readiness distinction
built in Phase 3).

### 2.4 Enable HTTPS, then flip `COOKIE_SECURE`

This project does not include a reverse proxy or TLS configuration. Put one in
front of this stack (nginx, Caddy, or your cloud provider's load balancer),
obtain a real certificate, and confirm HTTPS is working end-to-end **before**
setting `COOKIE_SECURE=True` in `.env` and restarting the backend container.

**This ordering matters and is not optional:** browsers will not send a
`Secure`-flagged cookie over plain HTTP. If `COOKIE_SECURE=True` is set before
HTTPS actually works, login will silently fail — no session cookie will ever be
sent by the browser, and every authenticated request will look like a fresh,
logged-out visitor with no obvious error message pointing at the real cause.

### 2.5 Run database migrations

Migrations are not run automatically by the compose file (a deliberate choice —
automatic migrations on every container start is a common source of accidental
data loss if a bad migration ever lands). Run manually:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backend \
  alembic upgrade head
```

### 2.6 Create the first admin account

Same bootstrap script used throughout development (Phase 4) — there is no
public registration endpoint by design:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec backend \
  python -m app.scripts.create_first_admin
```

## 3. Ongoing Operations

### Viewing logs
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f backend
```
Structured JSON logs (Phase 3) also persist to `./logs/medstt_backend.log` on the
host, via the volume mount in `docker-compose.prod.yml` — this survives container
restarts and rebuilds.

### Checking pipeline stage performance
```bash
curl http://localhost:8000/metrics | grep medstt_pipeline_stage
```
Real, measured stage durations (Phase 15) — use this to see actual current
performance rather than the anecdotal numbers recorded during development
testing (which will not exactly match your production hardware).

### Restarting after a code change
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml build backend
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d backend
```

### Backups
Postgres data lives in the `medstt_v1_postgres_data` named volume. A real backup
strategy (e.g. `pg_dump` on a schedule, or volume snapshots) is **not yet
implemented or documented** — flagged as a real gap, not solved by this runbook.

## 4. Rollback

If a deployment goes wrong:
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
git checkout <previous-known-good-commit>
docker compose -f docker-compose.yml -f docker-compose.prod.yml build
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```
Database migrations are **not automatically reversible** — if the failed
deployment included a migration, `alembic downgrade` may be needed manually, and
depending on the migration, could involve real data loss (e.g. the `recording_stage`
enum addition from the post-Phase-16 work cannot be cleanly reversed once rows use
the new value, per Postgres's own `ALTER TYPE ... ADD VALUE` limitations noted
when that migration was first built).

## 5. Known Limitations — Read Before Presenting This as Production-Ready

These are real, current gaps, not hidden or minimized:

- **No background task queue.** Chunking, transcription, NER extraction, and
  MedGemma drafting are all long-running synchronous HTTP requests — MedGemma
  drafting alone measured 80-258 seconds depending on task. A production
  deployment under real concurrent load will see these requests hold connections
  open for extended periods, with no queueing/backpressure mechanism. This is
  the single most significant scalability gap in the current system.
- **Single backend worker process, by design, not oversight.** The GPU model
  orchestrator (Phase 9) enforces a strict single-model-resident invariant on
  one GPU per process. Running multiple worker processes would each attempt
  independent GPU state management, breaking that invariant. Scaling this
  service requires a different GPU-sharing architecture, not just more workers.
- **No HTTPS/TLS configuration included** — must be provided by a fronting
  reverse proxy, per Section 1 and 2.4 above.
- **No automated database backup strategy.**
- **pyannote.audio version drift** — running 4.0.7 in the tested environment,
  though 3.1.1 was originally intended (see PROJECT_STATUS.md, Phase 9). Has not
  caused observed problems in CPU-only diarization, but is an open, unresolved
  item.
- **The nurse-intake AI-assisted vitals extraction path has never been tested
  against a real nurse-intake-stage recording** — the `recording_stage` field
  and two-recording workflow were added late in this project, and only the
  manual-entry intake path has real, confirmed end-to-end testing.
- **This runbook itself has been tested on one local WSL2/Docker Desktop
  environment.** It has not been tested against a genuinely separate remote
  server, a different Linux distribution, or a cloud GPU instance. Deploying to
  a materially different environment should be treated as a first real test, not
  an assumed-working repeat of what was validated here.