# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `curl -sf http://localhost:9000/minio/health/live` — expect exit 0
- **RabbitMQ:** `docker compose exec rabbitmq rabbitmq-diagnostics -q ping` — expect `Ping succeeded`
- **Mailpit:** `curl -sf http://localhost:8025/api/v1/info` — expect JSON response

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP sink (`1025`) + web UI/API (`8025`)
- `minio` — S3-compatible object storage, API `9000`, console `9001` (`minio-init` creates the bucket on boot)
- `rabbitmq` — message broker, AMQP `5672`, management UI/API `15672`, user/password `streamtube`
- `video-worker` — video processing worker (ffmpeg/ffprobe); the **only** image with ffmpeg installed

The `nestjs-api` container's main process is `tail -f /dev/null` — the API does **not** start automatically. After any `docker compose up`/restart, the dev server must be started manually (`npm run start:dev`) and migrations re-applied if the `db` volume was recreated (`npm run migration:run`).

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting

npm run migration:run                    # Apply pending TypeORM migrations
npm run migration:revert                 # Revert the last migration
npm run start:worker                     # Video worker (also runs as the video-worker service)
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # --runInBand is baked into the script
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

**Shared database warning:** integration/e2e tests run against the **same** `streamtube` database the dev server uses — there is no isolated test DB. Suites that drop/recreate tables (e.g., `migrations.integration-spec.ts`) can leave the dev schema inconsistent; if the API starts returning `relation "..." does not exist`, re-run `npm run migration:run`.

**ffmpeg-dependent suites run in the `video-worker` container**, not in `nestjs-api` (which has no ffmpeg):

```bash
# Unit/integration suites under src/videos/worker/ that shell out to ffmpeg/ffprobe
docker compose exec video-worker npm test -- --runInBand src/videos/worker/video-processor.service.integration-spec.ts

# e2e that exercises real processing (streaming flow)
docker compose exec video-worker npm run test:e2e -- videos-streaming
```

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `test:watch`, and any other persistent process.

## Video Worker

The `video-worker` service runs `npm run start:worker` (`src/main.worker.ts` → `WorkerModule`), consuming jobs from the `video-processing` queue and shelling out to ffmpeg/ffprobe.

- **No hot-reload:** `nest start --entryFile main.worker` has no `--watch`. After changing any code the worker uses (worker module, queue, storage, videos entities/config), run `docker compose restart video-worker` before testing — otherwise it keeps executing the old compiled code.
- **Consumer resubscribe gap (known issue):** if the worker's AMQP connection is force-closed (e.g., by the reconnection integration test), `QueueService` reconnects for publishing but does **not** re-register the consumer — the `video-processing` queue ends up with 0 consumers. Fix: `docker compose restart video-worker`. A proper resubscribe is a documented follow-up task.

## Object Storage (MinIO)

Uploads use S3 multipart with presigned part URLs. The presigned URL embeds the internal hostname `minio:9000` in the AWS SigV4 signature (the `Host` header is signed), so:

- The URL **cannot** be rewritten to `localhost` — the signature breaks.
- Manual `PUT`s to presigned URLs must run from inside a container on the Compose network (e.g., `docker compose cp file nestjs-api:/tmp/ && docker compose exec nestjs-api curl -X PUT ...`).

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

Two entrypoints share the same codebase:

- `src/main.ts` → `AppModule` — the HTTP API (`nestjs-api` service)
- `src/main.worker.ts` → `WorkerModule` — the queue consumer (`video-worker` service)

Phase 03 modules:

- `src/storage/` — `StorageService` (S3/MinIO client): multipart create/complete/abort, presigned part URLs, object streaming with range support. Config in `src/config/storage.config.ts`.
- `src/queue/` — `QueueService` (amqplib): publishes/consumes video-processing jobs on the `video-processing` queue; declares work queue + DLX/DLQ (`video-processing.dlq`) on boot. Config in `src/config/queue.config.ts`.
- `src/videos/` — `VideosController`/`VideosService` (upload lifecycle: draft → uploaded → processing → ready/error, streaming/download endpoints), `AbandonedUploadSweepService` (hourly `@Cron` marking stale drafts as error), and `src/videos/worker/` (consumer + `VideoProcessorService` running ffprobe/ffmpeg). Config in `src/config/videos.config.ts`.

New env vars are validated by Joi in `src/config/env.validation.ts` — `STORAGE_*` and `QUEUE_URL` are **required** (boot fails without them); see `.env.example`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
