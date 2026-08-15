---
libs:
  "amqplib":
    version: "^2.0.1"
    context7_id: "/amqp-node/amqplib"
    fetched_at: "2026-08-04T18:40:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1103.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-04T18:40:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1103.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-08-04T18:40:00-03:00"
  "nanoid":
    version: "^3.3.17"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-08-04T18:40:00-03:00"
  "@nestjs/schedule":
    version: "^6.1.3"
    context7_id: "/nestjs/schedule"
    fetched_at: "2026-08-04T18:40:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-08-04 18:34:18.153376823 -0300"
---

# phase-03-videos — Library References

Docs fetched via Context7 for the libraries introduced by this phase's decided TDs. Pinned against the installed stack: NestJS 11, TypeORM 0.3.28, TypeScript `module: nodenext` (CommonJS output).

---

## amqplib

**Introduced by:** TD-01 (RabbitMQ) — publisher in the API, consumer in the video worker, with DLX-based retry/dead-lettering.

Queue declaration with dead-lettering (the topology TD-06 requires):

```javascript
await ch.assertExchange('dlx', 'direct');
await ch.assertQueue('video-processing.dlq');
await ch.bindQueue('video-processing.dlq', 'dlx', 'dead');

await ch.assertQueue('video-processing', {
  durable: true,
  deadLetterExchange: 'dlx',
  deadLetterRoutingKey: 'dead',
});
```

Publishing a persistent job (survives broker restart):

```javascript
ch.publish('video', 'process', Buffer.from(JSON.stringify(job)), { persistent: true });
```

Consuming with manual ack semantics — the contract behind TD-06's bounded retry:

```javascript
ch.consume('video-processing', (msg) => {
  if (!msg) return;                 // null = consumer cancelled by server
  try {
    process(msg);
    ch.ack(msg);
  } catch (err) {
    ch.nack(msg, false, false);     // requeue=false → routed to the DLX
  }
});
```

Relevant `assertQueue` options: `durable`, `messageTtl`, `deadLetterExchange`, `deadLetterRoutingKey`, `maxLength`, `overflow` (`drop-head` | `reject-publish` | `reject-publish-dlx`).

Dead-lettered messages carry an `x-death` header with the redelivery history (`msg.properties.headers['x-death']`) — that is what bounds the retry count without an application-side counter.

Both the connection and the channel emit `error` and `handler-error`; wire listeners on both or an unhandled broker error kills the process.

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Introduced by:** TD-02 (multipart presigned upload), TD-05 (presigned GET for streaming/download), TD-07 (bucket provisioning), TD-08 (abort/lifecycle).

MinIO client configuration — S3-compatible endpoint requires path-style addressing:

```ts
new S3Client({
  endpoint: 'http://minio:9000',   // Compose service name, never localhost
  forcePathStyle: true,
  region: 'us-east-1',
  credentials: { accessKeyId, secretAccessKey },
});
```

Multipart lifecycle (TD-02's initiate → sign parts → complete):

```ts
const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key }));

// one presigned URL per part — the client PUTs the bytes directly to storage
const url = await getSignedUrl(
  s3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: [{ PartNumber, ETag }] },   // ETags returned by each PUT
}));

// cooperative cancel (TD-08's abort endpoint)
await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

`ListPartsCommand` enumerates already-uploaded parts — useful for resuming and for asserting state in integration tests.

Presigned GET for streaming/download (TD-05) — storage serves `Range`/`206` natively:

```ts
const url = await getSignedUrl(s3, new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: 'attachment; filename="video.mp4"',  // download variant
}), { expiresIn: 3600 });
```

`getSignedUrl` defaults to `expiresIn: 900` seconds. Signed `x-amz-*` headers must be passed via `unhoistableHeaders` or the upload request will fail the signature check.

---

## nanoid

**Introduced by:** TD-04 (unique public URL identifier).

**Version constraint — load-bearing:** nanoid 4+ is ESM-only. This project compiles to CommonJS, so pin **`nanoid@^3.3.17`** (the last CJS line, still maintained). Installing `nanoid@6` produces `ERR_REQUIRE_ESM` at runtime.

```ts
import { customAlphabet } from 'nanoid';

// URL-safe alphabet, 11 chars — YouTube-style public ID
const generatePublicId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-',
  11,
);
```

The default export `nanoid(size?)` uses the built-in `urlAlphabet`. `customAlphabet` requires an alphabet of ≤256 symbols. Use the crypto-backed entry point (`nanoid`), not `nanoid/non-secure`, since the ID is the public URL and must not be predictable.

---

## @nestjs/schedule

**Introduced by:** TD-08 (scheduled sweep expiring abandoned draft rows).

```ts
@Module({ imports: [ScheduleModule.forRoot()] })
export class AppModule {}

@Injectable()
export class DraftSweepService {
  @Cron(CronExpression.EVERY_HOUR, { name: 'EXPIRE_ABANDONED_DRAFTS', waitForCompletion: true })
  async expireAbandonedDrafts() { /* mark stale drafts as error */ }
}
```

`ScheduleModule.forRoot()` registers globally and exports `SchedulerRegistry` (which allows starting/stopping jobs by name — useful to disable the cron in tests).

Relevant `@Cron` options: `name` (registry lookup), `waitForCompletion` (prevents overlapping runs — required here, since a sweep may outlive its interval), `disabled`, `timeZone`.
