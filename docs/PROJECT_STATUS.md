# MedSTT Project Status — End of Phase 6

## Environment
- WSL2 Ubuntu, project root: ~/medstt
- Python 3.12 (venv at backend/.venv), Node 22, Docker Desktop w/ WSL integration
- GPU: RTX 4060 8GB VRAM, confirmed working in WSL and in Docker
- VSCode via Remote-WSL, all terminal commands run inside Ubuntu

## Model/resource plan (locked)
- MedASR: GPU, loaded on demand, unloaded after use
- MedGemma-4B-it (GGUF, Q4_K_M): GPU, swapped with MedASR, never both resident
- BioClinicalBERT/BiomedBERT (NER): CPU always
- Cloud fallback: Azure AI Speech + Azure OpenAI / HF Inference Endpoint, used on low confidence/backlog/OOM

## Docker infra (Phase 1) — container/network names use `medstt_v1_` prefix (renamed from plain `medstt_` due to collisions with other local projects)
- Postgres: container `medstt_v1_postgres`, host port **5433**, db `medstt_db`, user `medstt_admin`
- Redis: container `medstt_v1_redis`, host port **6380**, password in .env
- pgAdmin: container `medstt_v1_pgadmin`, host port **5051**, login admin@medstt.com
- Network: `medstt_v1_network`; volumes: `medstt_v1_postgres_data`, `medstt_v1_redis_data`, `medstt_v1_pgadmin_data`
- docker-compose.yml at project root; .env and .env.example at project root (gitignored except .env.example)

## Database schema (Phase 2) — 12 tables, Alembic-managed
users, sessions, patients, appointments, audio_recordings, audio_chunks, transcripts,
extracted_entity_sets, hitl_queue, intake_forms, prescriptions, audit_logs

Key patterns:
- UUID PKs via pgcrypto gen_random_uuid(), server-side default
- Soft delete (deleted_at) on patients/appointments only; users use UserStatus enum instead
- Row-versioning via supersedes_id (self-referential FK) on transcripts, extracted_entity_sets,
  intake_forms, prescriptions — preserves AI-original vs human-corrected as separate rows
- All enums centralized: app/models/enums.py has `pg_enum(enum_cls, name, create_type=True)`
  helper using values_callable=lambda: member.value — CRITICAL, ensures lowercase enum values
  stored in Postgres (e.g. 'admin' not 'ADMIN'). Always import and use pg_enum for any new
  enum column, never raw PgEnum().
- input_source enum type is SHARED across audio_recordings/intake_forms/prescriptions
  (create_type=False on the reuses)
- Current migration: single clean file, revision fedf0444a7e8, matches live DB exactly

Current admin account exists: username admin123 (password known to user only).
Nurse test account exists: username nurse_jane.

## Backend structure (Phases 2-4)
~/medstt/backend/
  .venv/
  app/
    core/         config.py (pydantic-settings, reads ../.env), logging_config.py (structlog,
                   JSON logs to stdout + rotating file at ~/medstt/logs/medstt_backend.log),
                   lifespan.py (verifies PG+Redis on startup, fails fast), security.py
                   (argon2id hashing, session token gen/hash)
    db/           session.py (async engine/session, DATABASE_URL_ASYNC uses localhost since
                   backend runs outside Docker for now), redis_client.py
    models/       base.py, mixins.py, enums.py (+ pg_enum helper), user.py, session.py,
                   patient.py, appointment.py, audio.py, transcript.py, extracted_entity.py,
                   intake_form.py, prescription.py, hitl.py, audit_log.py, __init__.py
                   (imports all — this is what Alembic autogenerate reads)
    schemas/      auth.py, user.py (Pydantic request/response, deliberately separate from ORM)
    services/     session_service.py (Redis+Postgres dual-write sessions, 8hr TTL),
                   auth_service.py (login/lockout after 5 fails, opportunistic rehash),
                   audit_service.py (write_audit_log — single write path for audit_logs table)
    api/          health.py (/health, /health/ready), auth.py (/auth/login, /logout, /me,
                   /change-password), admin_users.py (/admin/users CRUD + status),
                   patients.py (/patients CRUD, admin+nurse allowed on create/list/get,
                   admin-only soft-delete, ?search= param on list), hitl.py (/admin/hitl
                   list+claim+resolve, admin-only, empty until Phase 10+/12 populate it),
                   audit_logs.py (/admin/audit-logs, admin-only, filterable by action/
                   actor_user_id/target_entity_type/target_entity_id/success/date range,
                   paginated limit<=500), deps.py (get_current_user via cookie+Redis,
                   require_role/require_admin/require_nurse/require_doctor/require_nurse_or_doctor)
    middleware/   request_logging.py (request_id via structlog contextvars, X-Request-ID header)
    scripts/      create_first_admin.py (one-time CLI bootstrap, NOT an API endpoint)
    main.py       FastAPI app, CORS allow_origins currently ["http://localhost:5173"] only
  alembic/        env.py (imports Settings + Base, uses DATABASE_URL_SYNC/psycopg2,
                   compare_type=True, compare_server_default=True), versions/
  requirements.txt

Run backend: cd ~/medstt/backend && source .venv/bin/activate &&
  uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
Docs at http://localhost:8000/docs

## Auth design decisions (Phase 4)
- Server-side sessions in Redis (not JWT) — needed for instant revocation (admin deactivates
  user mid-shift must take effect immediately, not wait for token expiry)
- Session cookie name: medstt_session, httponly, samesite=lax, secure=False (MUST become True
  before any real deployment — behind HTTPS only)
- Password hashing: Argon2id, time_cost=3, memory_cost=64MiB, parallelism=1 (OWASP 2026 guidance)
- Admin-created users get random temp password + must_change_password=True forced flag —
  admin never learns the user's real ongoing password
- Changing password revokes ALL sessions for that user
- Suspending/deactivating a user immediately revokes all their active sessions (tested working)
- Admins cannot change their own status (prevents self-lockout)
- Login failure messages are deliberately generic (no username enumeration)
- Account lockout after 5 failed attempts (is_locked flag)
- Every significant action writes to audit_logs via write_audit_log() — pattern: call it
  explicitly after the business operation commits, don't try to infer audit-worthy actions
  from generic middleware

## Known deferred items (intentional, not forgotten)
- CORS is permissive only for localhost:5173 — fine for now, must be tightened for prod
- Redis config password is hardcoded in infra/redis/redis.conf rather than templated from
  .env (Redis config files don't support env var substitution) — revisit in hardening phase
- DATABASE_URL_ASYNC/SYNC in config.py hardcode "localhost" rather than using
  settings.POSTGRES_HOST — correct for now since backend runs outside Docker; MUST switch
  to using POSTGRES_HOST/REDIS_HOST once backend itself is containerized
- ground_truth_corrections was folded into existing transcript/entity versioning rather than
  a 13th table (query HUMAN_CORRECTED status instead) — revisit if training/eval needs
  denormalized storage later
- FIPS 140-2/3 compliance not addressed — if required later, Argon2id would need to be
  replaced with PBKDF2-SHA256 for password hashing specifically

## Frontend (Phase 6, in progress)
Stack: React + Vite + TypeScript, plain CSS Modules (no Tailwind, no UI kit).
One extra dependency beyond the Vite template: react-router-dom.

~/medstt/frontend/
  .env, .env.example    VITE_API_BASE_URL=http://localhost:8000 (frontend's own env,
                         separate from backend's -- Vite only reads VITE_-prefixed vars
                         from its own project root)
  src/
    types/     user.ts (UserRole, UserStatus, CurrentUser, UserSummary,
               CreateUserResponse -- mirrors schemas/auth.py + schemas/user.py exactly,
               snake_case field names kept identical to JSON keys on purpose),
               patient.ts (minimal Patient interface, intentionally incomplete --
               full patient CRUD schema not yet re-verified in detail, will extend
               when that page is actually built)
    api/       client.ts (apiRequest<T> wrapper: credentials:"include" hardwired on
               every call so the httponly medstt_session cookie is sent/received;
               normalizes FastAPI's {"detail": "..."} error shape into a thrown
               ApiError class with .status/.detail), auth.ts (login/logout/
               fetchCurrentUser/changePassword, 1:1 mapped to the four /auth/* endpoints)
    context/   AuthContext.tsx (AuthProvider + useAuth hook; calls /auth/me on mount
               to restore session state from the cookie -- no token ever stored in JS;
               isLoading flag prevents login-page flash during that initial check;
               refreshUser exposed for re-checking state after password change)
    components/
               ProtectedRoute.tsx (auth-gates + role-gates route children; also
               enforces must_change_password redirect at the guard level, not just
               post-login, so a direct URL visit can't bypass it)
               AppShell.tsx + AppShell.module.css (persistent sidebar + topbar shell
               used by all three role dashboards; sidebar has a role-colored accent
               bar -- admin blue #1E3A5F, nurse green #2E7D6B, doctor purple #6B4E9E --
               consistent visual identifier of which role's view is active)
               RootRedirect.tsx (used for "/" and catch-all "*" routes; sends an
               already-authenticated user to their role home instead of bouncing
               everyone to /login unconditionally)
    pages/     LoginPage.tsx + LoginPage.module.css (centered card layout, not the
               original inline-styled corner-pushed version), ChangePasswordPage.tsx
               (reuses LoginPage.module.css for visual consistency; explicitly logs
               out + redirects to /login after a successful change, since the backend
               revokes ALL sessions including the current one on password change --
               frontend can't just refreshUser() and continue), AdminDashboard.tsx,
               NursePage.tsx, DoctorPage.tsx (all three use AppShell now; still
               overview-only placeholders, no real CRUD UI yet), UnauthorizedPage.tsx
    App.tsx    Router shell: /login, /change-password (any authenticated role),
               /admin/* /nurse/* /doctor/* (role-gated via ProtectedRoute), /unauthorized,
               "/" and "*" both use RootRedirect

Design tokens (index.css): institutional blue-slate palette (--color-primary #1E3A5F),
off-white background (#F7F8FA), muted teal success / amber warning / red error, system-ui
font stack (no web font loading -- deliberate, keeps dev server light on the 6GB RAM
constraint). Chosen deliberately over generic SaaS-bright colors to read as an
institutional/clinical tool rather than a startup product.

Sidebar nav items reference future routes (/admin/patients, /admin/users, /admin/hitl,
/admin/audit-logs, etc.) that don't have real pages yet -- these currently 404 into
RootRedirect's catch-all. Intentional: the shell/nav structure is built once, pages get
filled in as their corresponding phase-5-backed features are built out next.

Tested end-to-end and confirmed working: login (admin + nurse accounts), logout,
session restore on page refresh via /auth/me, role-based post-login routing, role-gating
(nurse blocked from /admin -> /unauthorized), forced password-change interception at the
route-guard level, direct-URL-while-logged-out redirect to /login, already-authenticated
visits to "/" and unknown paths correctly landing on role home instead of /login.

Not yet built in Phase 6: real patient/user/HITL/audit-log list pages (APIs already exist
from Phase 5, UI pending), any form validation beyond HTML5 required/minLength, loading
skeletons, toasts/notifications, mobile-specific layout tuning beyond "doesn't visibly break."

## Full phase roadmap (from original plan)
Phase 0: WSL/env setup — DONE
Phase 1: Docker Compose (Postgres+Redis+pgAdmin) — DONE
Phase 2: DB schema + Alembic — DONE
Phase 3: FastAPI skeleton, structured logging, health checks — DONE
Phase 4: Auth & RBAC, sessions, audit logging, admin user mgmt — DONE
Phase 5: Remaining admin APIs (patient CRUD, HITL queue viewer, audit log viewer w/ filtering) — DONE
Phase 6: Frontend skeleton (React+Vite+TS), login flow, role-based routing — IN PROGRESS
  (auth/routing/shell/styling done and tested; role-specific data pages still pending)
## Frontend data pages (Phase 6 continuation, complete)
Built against the real Phase 5 API contracts (routers/schemas re-verified directly from
source before writing frontend code, not assumed from the status doc's earlier summary).

  src/types/patient.ts   CORRECTED from the original Step 6.3 placeholder -- real
                          Patient shape has mrn, phone_number, address, known_allergies,
                          created_by_id (matches schemas/patient.py PatientSummary exactly).
                          Also added CreatePatientPayload / UpdatePatientPayload.
  src/types/hitl.ts       HitlReason (7 values), HitlStatus (4 values), HitlItem,
                          ResolveHitlPayload, HITL_REASON_LABELS lookup for display text.
  src/types/audit.ts      AuditAction (13 values), AuditLogEntry -- mirrors
                          schemas/audit.py + enums.py exactly.
  src/api/patients.ts     list (with ?search=), get, create, update, delete (soft).
  src/api/hitl.ts         list (with ?status_filter=), claim, resolve.
  src/api/auditLogs.ts    list with full filter set (action/actor_user_id/
                          target_entity_type/target_entity_id/success/start_date/
                          end_date/limit/offset). Filter interface uses an explicit
                          string-keyed index signature ([key: string]: string | number
                          | boolean | undefined) alongside the named optional props --
                          required to satisfy apiRequest's params type, TS doesn't
                          structurally allow an all-optional named-props object where
                          an index signature is expected without it. Apply this same
                          pattern to any future filter-object types passed as `params`.
  src/api/users.ts        list, get, create, updateStatus.

  src/pages/PatientsPage.tsx   List (debounced 350ms search by name/MRN) + modal create
                          form. Available to both admin and nurse (matches backend:
                          create/list/get patients require only get_current_user, not
                          admin). Optional empty-string fields converted to undefined
                          before POST so Pydantic sees omission, not empty string.
  src/pages/UsersPage.tsx      Admin-only. List with role/status badges, Activate/
                          Suspend/Deactivate action buttons (flat status enum, no
                          formal state machine backend-side, so buttons not a dropdown).
                          Create-user modal shows the one-time temp password returned
                          by POST /admin/users -- backend never exposes it again after
                          this response, dialog copy is explicit about that.
                          KNOWN GAP (flagged, not fixed): an admin CAN click Suspend/
                          Deactivate on their own row in the UI; the backend correctly
                          rejects it (400, "Admins cannot change their own account
                          status") and the message surfaces in the error banner, but
                          the button isn't proactively hidden/disabled for the self
                          row. Low priority, revisit if it becomes annoying.
  src/pages/HitlPage.tsx        Admin-only. Filter tabs: "Pending review" (frontend-only
                          concept = omit status_filter, matches backend's own default
                          of pending+in_review), plus explicit pending/in_review/
                          resolved/dismissed. Claim button only shown on pending items,
                          Resolve form (required notes, resolve-or-dismiss) only on
                          in_review items -- UI can't attempt an invalid state
                          transition the backend would 409 on.
                          NOT YET LIVE-TESTED with real data: hitl_queue is empty until
                          Phase 10 (quality engine) / Phase 12 (NER validation) actually
                          write rows to it. Request/response wiring verified correct
                          against schemas/hitl.py; empty states confirmed working;
                          claim/resolve interaction itself unverified against live data.
  src/pages/AuditLogPage.tsx    Admin-only. Filters: action (dropdown, all 13 enum
                          values), target_entity_type (free-text -- backend doesn't
                          constrain this to an enum, populated ad hoc per-router),
                          success (all/success/failures). Offset-based pagination,
                          50/page, Next disabled when a page returns <50 rows (no
                          separate count endpoint needed). Any filter change resets
                          offset to 0 to avoid landing on an empty out-of-range page.
                          metadata_json collapsed by default, expandable per row.
                          Tested live against real logged data (logins, patient/user
                          creates, status changes) -- this page had real data to
                          verify against, unlike HITL.

Router (App.tsx) now has explicit flat routes (not wildcard nesting) for:
  /admin, /admin/patients, /admin/users, /admin/hitl, /admin/audit-logs (all role-gated
  to admin), /nurse, /nurse/patients (role-gated to nurse), /doctor (role-gated to
  doctor, no sub-pages yet -- doctor review workflow is Phase 14).

## Full phase roadmap (from original plan)
Phase 0: WSL/env setup — DONE
Phase 1: Docker Compose (Postgres+Redis+pgAdmin) — DONE
Phase 2: DB schema + Alembic — DONE
Phase 3: FastAPI skeleton, structured logging, health checks — DONE
Phase 4: Auth & RBAC, sessions, audit logging, admin user mgmt — DONE
Phase 5: Remaining admin APIs (patient CRUD, HITL queue viewer, audit log viewer w/ filtering) — DONE
Phase 6: Frontend (React+Vite+TS) — DONE
  Auth flow, role-based routing/gating, forced password-change interception, styled
  AppShell with role-accent sidebar, and working UI for every Phase 5 API (patients,
  users, HITL queue, audit log). Doctor-role pages are overview-only placeholders --
  intentional, since doctor review functionality depends on Phase 14 (doctor review
  workflow), not missing/forgotten.
Phase 7: Audio ingestion pipeline (upload/record, validation, normalization, storage) — NEXT
Phase 8: Chunking (VAD + speaker diarization, overlap logic)
Phase 9: Model orchestrator + local MedASR integration (GPU load/unload lifecycle)
Phase 10: Transcript quality engine (confidence, hallucination/omission checks, decision engine)
Phase 11: Cloud ASR fallback (Azure Speech) + consensus logic + HITL trigger
Phase 12: NER pipeline (BioClinicalBERT CPU, entity/assertion/temporal extraction, schema validation)
Phase 13: MedGemma integration (clinical interpretation, medication order drafting)
Phase 14: Doctor review workflow (edit/approve, audit trail, PDF generation)
Phase 15: Observability (Prometheus metrics, optional Grafana, tracing)
Phase 16: Hardening (input validation edge cases, rate limiting, secrets mgmt, security checklist,
   CORS tightening, HTTPS/secure cookies, Redis conf templating, FIPS decision if needed)
Phase 17: Full docker-compose production profile + deployment runbook + government presentation prep

## User's stated working style
- Wants terminal commands with exact path context (which folder)
- Prefers file creation via "create file at X, paste this code" rather than heredoc/cat commands
- Wants explanation of what code/steps do, not just the code itself
- Confirms each step works before proceeding — going phase by phase, testing at each checkpoint
- No zip files/archives — always explicit file/folder creation instructions
- Wants frontend to look genuinely designed (proper alignment/spacing, not corner-pushed
  inline-styled blocks) — addressed starting Step 6.7 with a real token system + AppShell
- Wants PROJECT_STATUS.md updated at major completions/milestones, not just end-of-phase