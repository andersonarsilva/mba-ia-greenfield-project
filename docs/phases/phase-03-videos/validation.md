---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 4
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-08-04 18:23:30.467185402 -0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-04 18:13:49.850616999 -0300"
issues:
  - id: AMB-1
    status: open
    summary: "Metadata set to persist is undefined — 'extração de metadados' has no field list"
  - id: AMB-2
    status: open
    summary: "Authorization for stream/download undefined while publication flow only lands in Phase 04"
  - id: MD-1
    status: open
    summary: "Bucket/key organization strategy has no TD (single vs split bucket, key layout)"
  - id: MD-2
    status: open
    summary: "No decision on cleanup policy for abandoned/incomplete multipart uploads"
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — The capability "Processamento automático do vídeo após upload (extração de duração e metadados)" does not define **which metadata** is persisted. TD-03 decides the extraction mechanism (`ffprobe -print_format json`) but neither the scope nor any TD states whether the videos table stores the full ffprobe JSON, a selected subset (e.g., codec, resolution, bitrate, container), or duration only. `/plan-build` cannot write the Data Model's `metadata` column contract without this. Explicit choice: define the persisted metadata contract (full JSON in `jsonb` vs typed subset columns vs both) in the decisions doc (revision of TD-03 or TD-06) or as clarified scope in context.md via `/plan-resolve`.
- **AMB-2** — "Reprodução via streaming" and "Download do vídeo pelo usuário" do not state **who** may stream/download in this phase. The publication flow (rascunho → publicação, visibilidade público/unlisted) only arrives in Phase 04, and anonymous viewing is Phase 05 scope — so in Phase 03 every video is effectively a draft owned by a channel. The Authorization Matrix cannot be written without deciding: owner-only access vs. any-authenticated vs. public-by-URL for `ready` videos. Explicit choice: define the Phase 03 access rule for stream/download endpoints (recommended candidate: owner-only in Phase 03, widened by Phases 04/05) via `/plan-resolve`.

### Missing Decisions

- **MD-1** — TD-02 decides multipart presigned upload but no TD decides the **storage organization**: single bucket vs. separate buckets for videos/thumbnails, key layout (e.g., `videos/{id}/original.mp4`, `thumbnails/{id}.jpg`), and bucket provisioning (who creates it — compose init, app bootstrap, or migration-like script). This is cross-component (API signs keys, worker reads/writes them, Compose provisions the bucket) and cannot be derived from best practices alone. Explicit choice: run `/research 03` (or extend the decisions doc) with a TD covering bucket/key organization and provisioning.
- **MD-2** — TD-02's own trade-off notes that "orphaned incomplete uploads need cleanup (abort/lifecycle rule)" but no TD decides the **abandoned-upload policy**: S3 lifecycle rule aborting incomplete multipart uploads after N days vs. explicit abort endpoint vs. scheduled cleanup job, and what happens to the orphaned `draft` row in the videos table. Explicit choice: add a TD (limits & policies) covering incomplete-upload expiry and draft-row cleanup.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI not in scope — backend-only phase.)_

## Resolved Issues

_No issues resolved yet._
