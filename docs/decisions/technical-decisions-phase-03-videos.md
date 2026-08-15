---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-08-04
scope_description: "Backend foundation for video upload and processing: message queue technology, 10GB direct-to-storage upload strategy, video worker architecture with FFmpeg, unique public URL identifier, streaming/download delivery, and video status lifecycle with failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the videos module (upload initiation/completion, streaming/download endpoints), the new infrastructure (object storage, queue, video worker) in Compose, and the videos table migration.
- `next-frontend/` — Frontend deferred: the video UI is out of scope for this phase (backend-only delivery per project plan). Cross-layer TDs below (TD-02, TD-05) define the client contract that the future frontend phase will consume; no frontend-side open decision in this document.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan defines a background processing service (queue) but leaves the technology explicitly as TBD in the architecture diagram. Every processing capability of this phase (metadata extraction, thumbnail generation, status transitions) depends on it. This is the main open stack decision of the phase.

**Options:**

### Option A: RabbitMQ (AMQP broker)
- Dedicated message broker container; API publishes jobs to a queue, the video worker consumes via AMQP (`amqplib`, optionally with `@golevelup/nestjs-rabbitmq`). Acks, retries and dead-letter exchanges are broker-native.
- **Pros:** Real broker semantics — per-message ack/nack, DLX (dead-letter) and TTL-based retry built into the broker, not the client. Language-agnostic (worker could be rewritten in anything). Management UI included. Maps 1:1 to the "Message Queue" container in the C4 diagram.
- **Cons:** One more heavyweight service in Compose (Erlang VM). AMQP concepts (exchanges, bindings, DLX) add a learning/config surface. NestJS's built-in RabbitMQ microservice transport is limited for job patterns, pushing toward a third-party lib or raw `amqplib`.

### Option B: BullMQ (Redis-backed job queue)
- Node.js job-queue library on top of Redis. First-class NestJS integration (`@nestjs/bullmq`), workers are Node processes using the same lib. Retry/backoff/DLQ implemented client-side by the library.
- **Pros:** Purpose-built for background jobs in Node — delayed jobs, retries with backoff, rate limiting out of the box. Official NestJS docs cover it. Redis is lighter than RabbitMQ and reusable later as cache. Simplest developer experience for a Node-only stack.
- **Cons:** Queue logic lives in the client library, not a broker — worker must be Node/BullMQ. Redis becomes a hard dependency with persistence configuration required (jobs are data, not cache). Less explicit messaging semantics (no exchanges/routing) — the "queue" is a library convention.

### Option C: Amazon SQS (with ElasticMQ locally)
- Managed queue in production, emulated locally with ElasticMQ in Docker. API publishes via `@aws-sdk/client-sqs`; worker polls.
- **Pros:** Zero-ops in production (AWS-aligned, same SDK family as S3). DLQ and visibility timeout are first-class. ElasticMQ is a light local emulator.
- **Cons:** Polling model (no push) adds latency and idle polling cost. Local emulator ≠ production parity (no real AWS behaviors like IAM). Ties the queue to the AWS ecosystem when the rest of the local infra (MinIO) is only S3-*compatible*. FIFO/ordering and long-polling nuances add config surface.

**Recommendation:** **Option A (RabbitMQ)** — the phase needs exactly one queue with robust failure semantics (ack/nack, retry, DLQ), and RabbitMQ provides them in the broker itself, keeping the worker a genuinely independent container as drawn in the C4 diagram; it avoids adding Redis as a second stateful dependency whose only role would be carrying jobs. BullMQ is a close second and equally defensible if a Redis cache is already foreseen for later phases.

**Decision:** A (RabbitMQ)
**Libraries:** amqplib

---

## TD-02: 10GB Upload Strategy

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** The phase requires uploads of up to 10GB without impacting API performance, with automatic draft pre-registration when the upload starts. Routing the file bytes through the NestJS API is explicitly the wrong path (blocks the event loop / requires huge buffers and timeouts). The storage itself is fixed by the project plan (S3-compatible — MinIO locally); what is decided here is how it is used. Cross-layer: the initiate → sign parts → complete handshake defines the contract a future frontend upload client must follow (exercised by e2e tests in this phase).

**Options:**

### Option A: Direct-to-storage multipart upload via presigned URLs
- Client asks the API to start an upload → API pre-registers the video as draft, calls `CreateMultipartUpload`, and issues presigned URLs per part (`UploadPart`); client uploads parts directly to MinIO/S3 in parallel and the API finishes with `CompleteMultipartUpload`.
- **Pros:** File bytes never touch the API — zero API load regardless of file size. Parts (5MB–5GB each, up to 10,000) can upload in parallel and be retried individually. Native S3/MinIO feature, no extra service. Single presigned PUT caps at 5GB, so multipart is the only presigned path that reaches 10GB.
- **Cons:** More client/API choreography (initiate → sign parts → complete). Orphaned incomplete uploads need cleanup (abort/lifecycle rule). Part size and count become API contract details.

### Option B: Resumable upload protocol (tus) with tusd/tus-node-server
- Dedicated resumable-upload protocol; a tus server receives chunked PATCH requests and assembles the file into S3 storage. Client uses a tus library.
- **Pros:** Standardized resumability (survives network drops mid-part), good client libs (Uppy). Offloads upload handling from the API.
- **Cons:** Introduces a whole extra service/protocol to operate and secure. Its S3 backend internally does multipart anyway — an indirection over Option A. Overkill when the S3 API already provides parts + retry.

### Option C: Streaming proxy through the API
- API receives the file as a stream (busboy/multer) and pipes it to storage with `@aws-sdk/lib-storage` `Upload`.
- **Pros:** Simplest client contract (one POST). Full server-side control (validation, virus scan hooks).
- **Cons:** Every byte flows through the API — connection slots, bandwidth and event-loop pressure for 10GB × N users; long-lived HTTP requests are fragile (timeouts, no per-part retry). Contradicts the phase's core non-functional requirement.

**Recommendation:** **Option A (multipart presigned URLs)** — it is the native S3/MinIO mechanism that satisfies the 10GB requirement with zero API involvement in the byte path, per-part parallelism/retry, and no new infrastructure; the draft pre-registration slots naturally into the "initiate" step.

**Decision:** A (Multipart presigned URLs direct to storage)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Video Worker Architecture and FFmpeg Invocation

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Processing (duration/metadata extraction, thumbnail generation) must happen automatically after upload, off the API process. The C4 diagram already fixes a separate "Video Worker (FFmpeg)" container. What remains open is how the worker is built and how it calls FFmpeg. Depends on TD-01 (queue).

**Options:**

### Option A: NestJS standalone application in the same codebase, spawning ffmpeg/ffprobe directly
- A second entrypoint (`main.worker.ts` or a `worker` app) inside `nestjs-project`, built from the same source, run as its own Compose service whose image includes the FFmpeg binary. Invokes `ffprobe`/`ffmpeg` via `child_process` (`execFile`) — no wrapper lib, since `fluent-ffmpeg` was archived in May 2025 and is unmaintained.
- **Pros:** Reuses entities, config, storage service and DI from the existing project — no duplication. Independent scaling/restart as a container. Direct spawn keeps full control of args and avoids a dead dependency. NestJS context gives structured DI + lifecycle for the consumer.
- **Cons:** API and worker share one deployable artifact (a change in either rebuilds both). Docker image for the worker needs FFmpeg installed (larger image). Care needed so worker doesn't boot API-only modules (HTTP server, mail).

### Option B: Separate minimal Node.js project for the worker
- A sibling project (e.g. `video-worker/`) with its own package.json, consuming the queue and talking to DB/storage with its own clients.
- **Pros:** Total isolation — smallest possible image and dependency surface. No risk of dragging API modules into the worker.
- **Cons:** Duplicates entity definitions, DB config, storage client and conventions already built in phases 01–02. Two dependency trees to maintain. Violates the project's continuity principle (reuse existing patterns) for little gain at this scale.

### Option C: In-process background consumer inside the API
- The API process itself consumes the queue and runs FFmpeg as child processes.
- **Pros:** No new service; simplest deploy.
- **Cons:** CPU/IO-heavy FFmpeg runs compete with HTTP traffic on the same container; a crash mid-processing takes the API down. Contradicts the C4 architecture, which defines the worker as a separate container.

**Recommendation:** **Option A** — same codebase, separate container, direct `child_process` invocation of `ffprobe` (metadata/duration, `-print_format json`) and `ffmpeg` (single-frame thumbnail extraction); it reuses everything phases 01–02 built while honoring the architecture's separate-worker container, and avoids depending on the archived `fluent-ffmpeg`.

**Decision:** A (NestJS standalone app, same codebase, direct child_process spawn)

**Revisions:**
- 2026-08-04 — Persisted metadata contract fixed: typed columns (`duration_seconds`, `width`, `height`, `codec`, `container`, `size_bytes`) plus a `jsonb` column holding the raw ffprobe output. Rationale: parameter clarified for the Data Model — typed columns keep listing/ordering queries indexable while the raw JSON avoids a migration each time a new field is needed.

---

## TD-04: Unique Public URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique, non-conflicting URL. The identifier appears in public links (watch page, streaming, download), so length, guessability and collision behavior matter. The DB primary key strategy of previous phases (UUID) is a given; the question is what the *public* identifier is.

**Options:**

### Option A: Short random ID via `nanoid` (dedicated public column)
- Generate an 11-char URL-safe random ID (YouTube-style) with `nanoid`, stored in a `UNIQUE` column separate from the PK; DB constraint + regenerate-on-collision guard.
- **Pros:** Short, clean URLs. ~64^11 space — collisions practically impossible, and the unique index makes them impossible in effect. Non-enumerable. Decouples public URL from internal PK.
- **Cons:** One extra column + generation step. Tiny theoretical collision handling (retry on unique-violation) must exist.

### Option B: Reuse the row UUID as the public identifier
- The videos table PK (UUID v4) doubles as the URL identifier.
- **Pros:** Zero extra code — uniqueness guaranteed by the PK. Consistent with users/channels IDs already exposed by the API.
- **Cons:** 36-char URLs are ugly for a video platform. Couples public contract to internal key (can't rotate/regenerate a link without changing the PK). No slug semantics.

### Option C: Title-derived slug + random suffix
- `my-video-title-x7k2p` generated from the title at publish time, unique index enforced.
- **Pros:** Human-readable, SEO-friendly URLs.
- **Cons:** Title isn't final at upload time (draft pre-registration happens before metadata editing — Phase 04 edits titles), forcing slug regeneration or stale slugs. More normalization edge cases (empty/emoji/duplicate titles).

**Recommendation:** **Option A (`nanoid` public ID)** — matches the platform reference model (YouTube-like short IDs), stays stable from draft creation onward regardless of later title edits, and the unique index + retry makes conflicts a non-issue; UUID stays as internal PK, consistent with previous phases.

**Decision:** A (nanoid public ID in dedicated unique column)
**Libraries:** nanoid

---

## TD-05: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Videos must play via streaming (no full download required) and be downloadable. The C4 diagram already states the frontend "streams from Object Storage". The decision is how playback/download requests reach the bytes: through the API or directly from storage. Cross-layer: the choice determines whether the future frontend player points at the API or at a presigned storage URL. Depends on TD-02 (files live in MinIO/S3).

**Options:**

### Option A: Presigned GET with API redirect
- `GET /videos/:publicId/stream` validates access, then issues a time-limited presigned GET URL and responds `302` (or returns the URL as JSON); the player hits MinIO/S3 directly, which natively serves `Range` requests / `206 Partial Content`. Download uses the same flow with `response-content-disposition: attachment`.
- **Pros:** Storage handles Range/seek natively and serves bytes at wire speed — API stays out of the data path (consistent with TD-02 and the C4 diagram). Access control still enforced at URL issuance. Download variant is a one-parameter change.
- **Cons:** URLs expire — player may need to re-request on long sessions. MinIO endpoint must be reachable by the browser (host-exposed port locally; CDN/domain in production). Link is shareable until expiry.

### Option B: API streaming proxy with Range support
- API implements `Range`/`206` itself: parses the header, calls `GetObject` with the byte range, pipes the stream to the response (`StreamableFile`).
- **Pros:** Single origin (no storage exposure), per-request authorization on every byte range, URLs never expire.
- **Cons:** Every video byte flows through Node — the same scalability problem TD-02 avoids on upload, now on the (much hotter) read path. Must hand-implement Range parsing/validation correctly. Doubles latency per seek.

### Option C: Hybrid — proxy only the download, presign the stream
- Streaming via presigned GET (Option A); download endpoint proxies with `Content-Disposition` set by the API.
- **Pros:** Streaming stays off-API; download gets exact filename control and auditability.
- **Cons:** Two delivery paths to maintain for marginal benefit — presigned URLs already control filename via `response-content-disposition`. A 10GB download still occupies the API for its full duration.

**Recommendation:** **Option A (presigned GET, storage serves Range/206)** — it matches the architecture diagram literally (frontend streams from Object Storage), reuses MinIO's native, battle-tested Range implementation instead of hand-rolling one, and keeps the API on the control plane only, for both streaming and download.

**Decision:** A (Presigned GET; MinIO/S3 serves Range/206)

**Revisions:**
- 2026-08-04 — Phase 03 access rule fixed: stream and download are owner-only (authenticated channel owner). Rationale: parameter tightened by phase boundary — visibility/publication lands in Phase 04 and anonymous viewing in Phase 05, so every video in this phase is an unpublished draft.

---

## TD-06: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The plan requires the draft → processing → ready/error cycle reflected in the database, and the phase must define what happens when processing fails (FFmpeg error, corrupt file, worker crash). Depends on TD-01 (queue retry/DLQ mechanics).

**Options:**

### Option A: Linear lifecycle with bounded retries and DLQ
- States: `draft` (created at upload initiation) → `uploaded` (multipart completed, job published) → `processing` (worker picked up) → `ready` | `error`. Worker retries transient failures with backoff up to N times (queue-level, e.g. DLX/TTL); after exhaustion the message goes to a dead-letter queue and status is set to `error` with a stored reason.
- **Pros:** Every state visible in DB (phase acceptance criterion). Transient faults (storage blip) self-heal via retry; poison messages don't loop forever. DLQ preserves failed jobs for inspection/reprocessing. Idempotent processing (status guard) makes redelivery safe.
- **Cons:** One more state (`uploaded`) than the minimal cycle. Retry/DLX topology must be configured and tested.

### Option B: Minimal cycle, fail-fast
- States: `draft` → `processing` → `ready` | `error`; any worker failure immediately marks `error`, no retry.
- **Pros:** Simplest possible implementation and tests.
- **Cons:** A transient network/storage hiccup permanently fails a 10GB upload the user just completed — poor UX and avoidable support load. Loses the failed job (no DLQ) unless rebuilt by hand.

**Recommendation:** **Option A** — the `uploaded` intermediate state distinguishes "waiting for worker" from "worker running" (useful for UX and stuck-job detection), and bounded retry + DLQ is the standard failure contract for queue consumers; fail-fast on a 10GB re-upload is an unacceptable user cost for the few lines of retry topology it saves.

**Decision:** A (draft → uploaded → processing → ready/error, bounded retries + DLQ)

---

## TD-07: Storage Organization and Bucket Provisioning

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** TD-02 fixes multipart presigned upload but does not decide how the S3-compatible storage is organized: one bucket or one per asset type, the object key layout, and who provisions the bucket + lifecycle configuration (raised as MD-1 in validation). Cross-component: the API signs keys, the worker reads/writes them, and Compose provisions the infrastructure.

**Options:**

### Option A: Single bucket, per-video key prefix, provisioned by a Compose init container
- One bucket (e.g., `videos`); all assets of a video live under its prefix: `videos/{videoId}/original.{ext}` and `videos/{videoId}/thumbnail.jpg`. A one-shot Compose service runs `mc mb --ignore-existing` + `mc ilm` (idempotent) before the API/worker start.
- **Pros:** Deleting a video = deleting one prefix. One bucket to configure (policy, lifecycle) and one env var. Init container keeps provisioning declarative in `compose.yaml`, mirroring how the DB is provisioned by its image. `mc` is the reliable path for MinIO lifecycle rules.
- **Cons:** Public-read policies (if ever needed) apply per bucket — mixing asset types in one bucket makes per-type policy impossible later. Init container adds one Compose service.

### Option B: Separate buckets per asset type (`videos`, `thumbnails`)
- Two buckets, keys `{videoId}.{ext}` / `{videoId}.jpg`, provisioned by the same init-container approach.
- **Pros:** Per-type bucket policy (e.g., thumbnails public-read, videos presigned-only) without prefix gymnastics. Cleaner separation for lifecycle tuning per type.
- **Cons:** Two of everything (env vars, policies, lifecycle configs, test fixtures). Cross-bucket cleanup when deleting a video. The policy benefit is speculative — this phase serves both types via presigned URLs.

### Option C: Single bucket, provisioning at application bootstrap
- API (or worker) calls `CreateBucket`/`PutBucketLifecycleConfiguration` on boot if missing.
- **Pros:** No extra Compose service; works in any environment the app reaches.
- **Cons:** Mixes infrastructure provisioning into application code and grants the app admin-ish permissions it otherwise doesn't need. Race between API and worker booting concurrently. Harder to reason about in production (who owns the bucket config?).

**Recommendation:** **Option A** — per-video prefixes make asset co-location and future deletion trivial, a single bucket minimizes config surface for a phase where both asset types are delivered via presigned URLs anyway, and the init container keeps provisioning declarative and idempotent in Compose (matching how the rest of the local infra is provisioned).

**Decision:** A (Single bucket, per-video key prefix, Compose init container provisioning)

---

## TD-08: Abandoned Upload Cleanup Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** TD-02's trade-off notes that incomplete multipart uploads leak storage (parts are retained and billed until aborted) and each abandoned upload leaves an orphaned `draft` row (raised as MD-2 in validation). A policy is needed for both halves: the storage parts and the DB row. Depends on TD-01 (no queue involvement needed) and TD-07 (lifecycle config lives with bucket provisioning).

**Options:**

### Option A: Storage lifecycle rule + scheduled draft sweep
- Bucket lifecycle rule `AbortIncompleteMultipartUpload` (e.g., `DaysAfterInitiation: 1`) configured at provisioning time (TD-07 init container); a scheduled job in the API (`@nestjs/schedule` cron) marks `draft` rows older than the same window as `error` (reason: upload expired). An explicit `abort` endpoint lets the client cancel early.
- **Pros:** Parts cleanup is native storage behavior — zero app code, works even if the app is down. DB sweep is a few lines on a cron. Windows for storage and DB are aligned by config. Explicit abort gives immediate cleanup for cooperative clients.
- **Cons:** Adds `@nestjs/schedule` dependency. Two mechanisms to keep aligned (lifecycle days vs. sweep cutoff). MinIO requires `mc ilm` for reliable lifecycle setup (some S3 clients fail to persist the rule).

### Option B: Client-driven abort endpoint only
- The client is responsible for calling `abort` on failure; no automated cleanup.
- **Pros:** Simplest server; no scheduler, no lifecycle config.
- **Cons:** Browsers crash, tabs close, networks die — uncooperative abandonment is the common case, and parts then leak forever. Draft rows accumulate unbounded. Unacceptable for 10GB objects.

### Option C: Worker reconciliation job
- The video worker periodically lists incomplete multipart uploads (`ListMultipartUploads`), aborts stale ones, and expires matching draft rows in one pass.
- **Pros:** Single mechanism owns both halves; no lifecycle config dependency.
- **Cons:** Reimplements in app code what the storage does natively; requires list permissions and pagination handling; the worker's job is video processing — reconciliation is scope creep on it (violates single-responsibility of the queue consumer).

**Recommendation:** **Option A** — native lifecycle handles the expensive half (10GB of parts) with zero code and total reliability, the cron sweep is trivial and keeps the DB honest, and the explicit abort endpoint covers the cooperative path; configure the lifecycle via `mc ilm` in the TD-07 init container to avoid the known client-persistence pitfalls.

**Decision:** A (Lifecycle rule + scheduled draft sweep + explicit abort endpoint)
**Libraries:** @nestjs/schedule

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Message queue technology | RabbitMQ (AMQP broker) | A — RabbitMQ |
| TD-02 | Cross-layer | 10GB upload strategy | Multipart presigned URLs direct to storage | A — Multipart presigned |
| TD-03 | Backend | Worker architecture / FFmpeg | NestJS standalone app, same codebase, direct `child_process` spawn | A — NestJS standalone + spawn |
| TD-04 | Backend | Unique public URL identifier | `nanoid` short ID in dedicated unique column | A — nanoid |
| TD-05 | Cross-layer | Streaming and download delivery | Presigned GET; MinIO/S3 serves Range/206 | A — Presigned GET |
| TD-06 | Backend | Status lifecycle and failure handling | draft → uploaded → processing → ready/error, retry + DLQ | A — retry + DLQ |
| TD-07 | Backend | Storage organization and bucket provisioning | Single bucket, per-video prefix, Compose init container | A — single bucket + init container |
| TD-08 | Backend | Abandoned upload cleanup policy | Lifecycle rule + scheduled draft sweep + abort endpoint | A — lifecycle + sweep |

---

## Research Notes

- Sources: AWS SDK for JavaScript v3 docs (S3 multipart, `@aws-sdk/s3-request-presigner`), RabbitMQ and BullMQ official docs, NestJS 11 docs, `fluent-ffmpeg` repository (archived 2025-05-22 — motivates direct `child_process` usage).
- The context7 MCP server referenced by the project rules is not configured in `.mcp.json` (only `postgres` is present). Research used official documentation via web instead. Library versions must be pinned against the installed stack (NestJS 11, TypeORM 0.3.28, Node 22) during `plan-resolve` (`library-refs.md`) — and context7 should be added to `.mcp.json` before that stage.
