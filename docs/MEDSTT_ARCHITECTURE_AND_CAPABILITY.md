# MedSTT: Architecture and Capability Document

**Purpose of this document:** a technical, factual account of what MedSTT is,
how it works, what it has been verified to do, and what its current, honest
limitations are. This document is written for government technical review. It
does not minimize open items or unresolved risks — every limitation named here
is a real, current state of the system, not a hypothetical edge case.

---

## 1. What MedSTT Does

MedSTT converts audio recordings of clinician-patient conversations into
structured clinical documentation: a nurse intake record (vitals, prior test
results) and a doctor's prescription record (problem summary, symptoms,
medications, advice, follow-up), with a generated PDF as the final clinical
artifact. It is designed around a three-role model — admin, nurse, doctor —
matching how a real clinical encounter proceeds.

**The system does not make clinical decisions.** Every AI-generated output —
transcripts, extracted entities, drafted intake data, drafted prescriptions —
is explicitly a draft requiring human review before it becomes part of the
clinical record. This is not a design aspiration; it is enforced at multiple
levels described in Section 3.

---

## 2. System Architecture

### 2.1 High-level pipeline

A clinical encounter produces one or two audio recordings (a nurse vitals-
taking session and/or a doctor consultation), which move through the following
stages:

1. **Ingestion** — upload or live browser recording, validated (real file
   properties inspected via ffprobe, not trusted from client-supplied metadata)
   and normalized to a standard 16kHz mono WAV format.
2. **Chunking** — voice activity detection (Silero VAD) and speaker
   diarization (pyannote.audio) segment the recording into speaker-labeled,
   appropriately-sized chunks.
3. **Transcription** — each chunk is transcribed by a local, GPU-resident
   speech-to-text model (Google's MedASR), run concurrently with a cloud
   fallback (Azure AI Speech) for cross-verification.
4. **Quality assessment** — each transcript is scored using the model's own
   real per-token confidence (not a heuristic proxy), combined with pattern-
   based checks (repetition, speech-rate anomalies) and cross-checked against
   the cloud transcription for agreement.
5. **Human-in-the-loop (HITL) flagging** — any transcript failing quality or
   consensus checks is routed to a review queue rather than silently accepted.
6. **Entity extraction** — validated transcripts are processed by clinical
   named-entity-recognition models (disease and medication/chemical entities),
   each extraction independently confidence-scored and validated.
7. **Drafting** — a local large language model (Google's MedGemma) drafts
   structured clinical content from the validated transcripts and entities:
   vitals/test extraction for nurse intake, and problem/symptoms/medications/
   advice/follow-up for the doctor's prescription.
8. **Human review and finalization** — a doctor reviews and edits the drafted
   prescription; a nurse reviews and edits the intake form. Only after explicit
   finalization does either become part of the permanent record. A PDF is
   generated at finalization, with an explicit AI-provenance disclosure printed
   on the document itself.

### 2.2 Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Backend | FastAPI, async SQLAlchemy, Alembic | Python 3.12 |
| Frontend | React, Vite, TypeScript | Role-based routing and access control |
| Database | PostgreSQL 16 | UUID primary keys, append-only audit log, row-versioning for AI-generated content |
| Cache/sessions | Redis 7 | Server-side sessions (not JWT) for instant revocation |
| Local speech-to-text | google/medasr (105M param Conformer) | GPU-resident, CUDA required |
| Cloud speech-to-text | Azure AI Speech | Runs concurrently with local ASR for cross-verification |
| Speaker diarization | pyannote.audio 4.0.7 | CPU-only in this deployment |
| Voice activity detection | Silero VAD | CPU-only |
| Clinical entity extraction | OpenMed NER models (PharmaDetect, DiseaseDetect, 434M params each) | CPU-only |
| Clinical text generation | google/medgemma-1.5-4b-it | GPU-resident, CUDA required, ~8GB VRAM |
| Observability | Prometheus metrics, structured JSON logging, cross-request tracing | |
| Containerization | Docker, Docker Compose | GPU passthrough via NVIDIA Container Toolkit |

### 2.3 GPU resource management

The local speech-to-text model (MedASR) and the local text-generation model
(MedGemma) both require CUDA and cannot both be resident in GPU memory
simultaneously on an 8GB card — MedGemma alone was measured using approximately
6.2GB of the card's 8GB capacity in isolation. A dedicated model orchestrator
enforces strict mutual exclusion: only one model is ever loaded at a time, with
an explicit lock preventing race conditions during concurrent requests, and
explicit memory cleanup on every model swap. This is a hard architectural
constraint of the current deployment, not an optimization choice — it directly
determines that the production deployment runs as a single backend worker
process (see Section 5).

---

## 3. Safety and Human Oversight Design

This system was built around a consistent principle: AI-generated content is
never presented as, or silently converted into, an authoritative clinical
record without human review. This is enforced structurally, not just through
policy:

- **Every AI-generated database record carries explicit provenance fields**
  (which model produced it, what version, the complete raw output) that
  persist even after a human edits the record. The original AI output is never
  silently overwritten or lost.
- **Prescriptions and intake forms cannot be finalized by the system itself.**
  They are created in a draft state and require an explicit action by the
  responsible role (doctor for prescriptions, nurse for intake forms) to
  finalize. Editing a finalized record is rejected by the system.
- **The final PDF document itself carries an explicit AI-provenance
  disclosure** whenever any part of its content was AI-drafted, stating the
  model used and that the content was reviewed and approved by the named
  clinician and requires independent verification. This is not only an
  internal database flag — it is visible on the physical/printed clinical
  artifact.
- **A dedicated human-in-the-loop review queue** captures any transcript that
  fails quality checks (low model confidence, detected repetition, anomalous
  speech rate) or disagrees materially with the independent cloud
  transcription, routing these to an administrator for review rather than
  silently accepting uncertain content into the pipeline.
- **Both underlying AI models' own publishers state explicitly that their
  outputs require independent clinical verification and are not intended to
  directly inform diagnosis or treatment decisions.** This system's entire
  review-and-finalize architecture exists specifically to honor that
  requirement, not as an incidental feature.

### 3.1 A concrete example of this design working as intended

During development, a real quality issue was identified and corrected: an
early version of the vitals-extraction logic misidentified a spoken phrase
describing bowel movement frequency ("six or seven times a day") as a pulse
rate reading. This was caught through structured testing against real
recordings before the feature was used in any live capacity, and the
extraction logic was rebuilt to require the model to cite the exact source
sentence supporting any extracted value — creating a verifiable link a human
reviewer can check, rather than trusting an unverifiable number. This is
representative of the broader development approach: every AI integration in
this system was tested against real audio and real transcripts before being
considered complete, and issues found in that testing were treated as design
problems requiring a structural fix, not tuned away with a quick patch.

---

## 4. Data Handling and Security

- **Authentication**: server-side sessions (Redis-backed), enabling instant
  revocation of access — an administrator deactivating a compromised or
  departing user's account takes effect immediately, not upon token expiry.
- **Password storage**: Argon2id (current OWASP recommendation), with account
  lockout after repeated failed attempts and rate limiting on the login
  endpoint as a separate, complementary protection against broader abuse.
- **Role-based access control**: every endpoint enforces role requirements
  (admin/nurse/doctor) at the API layer.
- **Audit logging**: every significant action (logins, record creation,
  edits, status changes, HITL resolutions, prescription finalization) is
  written to an append-only audit log with no update or delete capability.
- **Data integrity**: UUID primary keys (record existence/count is not
  inferable from sequential IDs), soft-deletion of clinical records (never
  destructive deletion), and row-versioning for AI-generated content
  (original and human-corrected versions both preserved, never overwritten).
- **File handling**: uploaded audio and generated PDFs are stored using
  randomly-generated filenames, never the original filename or any
  patient-identifying string, reducing the risk of PHI exposure through
  filesystem-level access independent of database access controls.
- **A dedicated security hardening review** was performed covering CORS
  configuration, cookie security, secrets management, input validation, and
  request size limits. This review found and corrected two real gaps: a
  missing global request-size limit on JSON endpoints, and a `.gitignore`
  omission that could have allowed PDF files containing real patient names and
  clinical data to be committed to version control (confirmed, via direct
  inspection of repository history, that this had not yet actually occurred
  before the fix was applied).

**What this system does not yet provide**, stated plainly: HTTPS/TLS
termination (must be provided by infrastructure fronting this system in any
real deployment); FIPS 140-2/3 compliance (would require replacing the current
password hashing algorithm if formally required); and an automated database
backup strategy.

---

## 5. Known Limitations

This system has real, current limitations. They are listed here directly
because an accurate account of what is not yet solved is more useful to a
technical reviewer than a document that omits them.

1. **No background task queue.** Several pipeline stages (chunking,
   transcription, entity extraction, AI-assisted drafting) are long-running
   synchronous operations — the text-generation step alone has been measured
   taking 80 to 258 seconds depending on the task. Under concurrent real-world
   load, this is the single most significant scalability constraint of the
   current system.
2. **Single backend process, by design.** The GPU resource management
   approach described in Section 2.3 requires this; scaling beyond one
   process would require a different GPU-sharing architecture.
3. **The speaker diarization library is running a different version than
   originally intended** (a newer release pulled in during development,
   rather than the specific version originally pinned to avoid a known
   resource-usage issue in GPU contexts). This has not caused an observed
   problem in the current CPU-only diarization configuration, but remains an
   open item to formally resolve.
4. **The AI-assisted nurse intake extraction path is implemented but has not
   been tested against a real two-recording clinical encounter** (one
   recording for vitals-taking, one for the doctor consultation) — only the
   manual-entry intake path has complete, real-world verification. This
   reflects the genuine sequencing of development, not a hidden gap.
5. **This system has been deployed and verified in one environment**
   (a local development machine running Docker with GPU passthrough). It has
   not yet been tested on a separate, independent server or cloud
   infrastructure. A first deployment to new infrastructure should be treated
   as a real validation exercise, not an assumed repeat of prior testing.

---

## 6. Development and Verification Approach

Every model and library integrated into this system was independently
verified against real data before being considered complete — this included,
in multiple cases, discovering that an initial assumption (a model's expected
behavior, a library's version compatibility, an extraction prompt's
reliability) was wrong, and correcting the underlying design rather than
patching around the symptom. Specific instances of this discipline, beyond the
vitals-extraction example in Section 3.1, include:

- A dependency conflict between the originally-planned clinical NER library
  and the rest of the system's dependencies was identified before it caused a
  production issue, leading to a considered switch to an alternative,
  actively-maintained NER model family with equivalent clinical coverage.
- A data-integrity bug causing duplicate transcript records to silently
  accumulate across repeated processing runs was traced to its root cause (a
  database foreign-key behavior interacting with a cleanup routine that didn't
  account for it) and fixed at the source, with existing corrupted data
  cleaned up as part of the same fix, rather than working around the symptom.
- Text-parsing logic for AI-generated clinical drafts was rebuilt after real
  test output revealed a failure mode (a common word inside a sentence being
  mistaken for a section heading) that a review of the code alone had not
  surfaced.

This pattern — build, test against real data, find real problems, fix them at
the root — was the consistent approach across the full 17-phase development
process, and is reflected in the project's own internal status documentation
maintained throughout development.