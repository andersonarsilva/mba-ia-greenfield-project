import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { cleanAllTables } from '../src/test/create-test-data-source';

interface LoginResponse {
  access_token: string;
}

interface InitiateUploadResponse {
  id: string;
  public_id: string;
  parts: { partNumber: number; url: string }[];
}

interface CompleteUploadResponse {
  status: string;
}

interface ErrorResponse {
  error: string;
  message: string[];
}

interface VideoRow {
  status: string;
  storage_key: string | null;
  upload_id: string | null;
}

interface QueueInfo {
  messages: number;
}

interface QueueMessage {
  payload: string;
}

const MANAGEMENT_URL = 'http://rabbitmq:15672';
const MANAGEMENT_AUTH =
  'Basic ' + Buffer.from('streamtube:streamtube').toString('base64');

async function purgeManagementQueue(queue: string): Promise<void> {
  await fetch(
    `${MANAGEMENT_URL}/api/queues/%2f/${encodeURIComponent(queue)}/contents`,
    { method: 'DELETE', headers: { Authorization: MANAGEMENT_AUTH } },
  );
}

async function pollQueueMessageCount(
  queue: string,
  predicate: (count: number) => boolean,
  timeoutMs = 10000,
): Promise<number> {
  const start = Date.now();
  let last = -1;
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(
      `${MANAGEMENT_URL}/api/queues/%2f/${encodeURIComponent(queue)}`,
      { headers: { Authorization: MANAGEMENT_AUTH } },
    );
    const info = (await res.json()) as QueueInfo;
    last = info.messages;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`pollQueueMessageCount timed out at ${last}`);
}

async function getQueueMessages(
  queue: string,
  count: number,
): Promise<QueueMessage[]> {
  const res = await fetch(
    `${MANAGEMENT_URL}/api/queues/%2f/${encodeURIComponent(queue)}/get`,
    {
      method: 'POST',
      headers: {
        Authorization: MANAGEMENT_AUTH,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        count,
        ackmode: 'ack_requeue_true',
        encoding: 'auto',
      }),
    },
  );
  return (await res.json()) as QueueMessage[];
}

describe('videos-upload-complete (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  const queueName = process.env.QUEUE_NAME as string;
  const dlq = process.env.QUEUE_DEAD_LETTER_QUEUE as string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await purgeManagementQueue(queueName);
    await purgeManagementQueue(dlq);
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (
      authService as unknown as { mailService: MailService }
    ).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
        return Promise.resolve();
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as LoginResponse).access_token;
  }

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      title: 'My video',
      filename: 'movie.mp4',
      size_bytes: 1024,
      content_type: 'video/mp4',
      ...overrides,
    };
  }

  async function initiate(
    accessToken: string,
  ): Promise<InitiateUploadResponse> {
    const res = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(validPayload());
    return res.body as InitiateUploadResponse;
  }

  async function uploadAllParts(
    parts: { part_number: number; url: string }[],
  ): Promise<{ parts: { part_number: number; etag: string }[] }> {
    const uploaded: { part_number: number; etag: string }[] = [];
    for (const part of parts) {
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.from('e2e content')),
      });
      uploaded.push({
        part_number: part.part_number,
        etag: res.headers.get('etag') as string,
      });
    }
    return { parts: uploaded };
  }

  describe('POST /videos/:publicId/uploads/complete', () => {
    it('completes the upload and publishes the processing job', async () => {
      const accessToken = await registerConfirmAndLogin(
        'complete1@example.com',
      );
      const initiated = await initiate(accessToken);
      const completeBody = await uploadAllParts(
        initiated.parts.map((p) => ({
          part_number: p.partNumber,
          url: p.url,
        })),
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${initiated.public_id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(completeBody);

      expect(res.status).toBe(200);
      expect((res.body as CompleteUploadResponse).status).toBe('uploaded');

      const row = await dataSource.query<VideoRow[]>(
        'SELECT * FROM "videos" WHERE "public_id" = $1',
        [initiated.public_id],
      );
      expect(row[0].storage_key).toBeTruthy();
      expect(row[0].upload_id).toBeNull();

      await pollQueueMessageCount(queueName, (count) => count === 1);
      const [message] = await getQueueMessages(queueName, 1);
      const payload = JSON.parse(message.payload) as {
        videoId: string;
        storageKey: string;
      };
      expect(payload.videoId).toBe(initiated.id);
      expect(payload.storageKey).toBe(row[0].storage_key);
    }, 15000);

    it('rejects completing a video that is not in draft', async () => {
      const accessToken = await registerConfirmAndLogin('notdraft@example.com');
      const initiated = await initiate(accessToken);
      const completeBody = await uploadAllParts(
        initiated.parts.map((p) => ({
          part_number: p.partNumber,
          url: p.url,
        })),
      );
      await request(app.getHttpServer())
        .post(`/videos/${initiated.public_id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(completeBody);
      await pollQueueMessageCount(queueName, (count) => count === 1);

      const res = await request(app.getHttpServer())
        .post(`/videos/${initiated.public_id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(completeBody);

      expect(res.status).toBe(409);
      expect((res.body as ErrorResponse).error).toBe('INVALID_VIDEO_STATUS');

      const countAfter = await pollQueueMessageCount(
        queueName,
        () => true,
        2000,
      ).catch(() => 1);
      expect(countAfter).toBe(1);
    }, 15000);

    it('rejects malformed parts', async () => {
      const accessToken = await registerConfirmAndLogin(
        'malformed@example.com',
      );
      const initiated = await initiate(accessToken);

      const missingParts = await request(app.getHttpServer())
        .post(`/videos/${initiated.public_id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({});
      expect(missingParts.status).toBe(400);
      expect((missingParts.body as ErrorResponse).message.join(' ')).toMatch(
        /parts/,
      );

      const missingEtag = await request(app.getHttpServer())
        .post(`/videos/${initiated.public_id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1 }] });
      expect(missingEtag.status).toBe(400);

      const row = await dataSource.query<VideoRow[]>(
        'SELECT * FROM "videos" WHERE "public_id" = $1',
        [initiated.public_id],
      );
      expect(row[0].status).toBe('draft');
    });

    it('rejects completing a video from another channel', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'complete-owner@example.com',
      );
      const initiated = await initiate(ownerToken);
      const completeBody = await uploadAllParts(
        initiated.parts.map((p) => ({
          part_number: p.partNumber,
          url: p.url,
        })),
      );

      const intruderToken = await registerConfirmAndLogin(
        'complete-intruder@example.com',
      );

      const res = await request(app.getHttpServer())
        .post(`/videos/${initiated.public_id}/uploads/complete`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .send(completeBody);

      expect(res.status).toBe(404);
      expect((res.body as ErrorResponse).error).toBe('VIDEO_NOT_FOUND');

      const row = await dataSource.query<VideoRow[]>(
        'SELECT * FROM "videos" WHERE "public_id" = $1',
        [initiated.public_id],
      );
      expect(row[0].status).toBe('draft');
    });
  });

  describe('DELETE /videos/:publicId/uploads', () => {
    it('lets the owner abort an in-progress upload', async () => {
      const accessToken = await registerConfirmAndLogin(
        'abort-owner@example.com',
      );
      const initiated = await initiate(accessToken);
      await fetch(initiated.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.from('partial')),
      });

      const res = await request(app.getHttpServer())
        .delete(`/videos/${initiated.public_id}/uploads`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(204);

      const row = await dataSource.query<VideoRow[]>(
        'SELECT * FROM "videos" WHERE "public_id" = $1',
        [initiated.public_id],
      );
      expect(row).toHaveLength(0);
    });

    it('rejects aborting a video that is not in draft', async () => {
      const accessToken = await registerConfirmAndLogin(
        'abort-notdraft@example.com',
      );
      const initiated = await initiate(accessToken);
      const completeBody = await uploadAllParts(
        initiated.parts.map((p) => ({
          part_number: p.partNumber,
          url: p.url,
        })),
      );
      await request(app.getHttpServer())
        .post(`/videos/${initiated.public_id}/uploads/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send(completeBody);

      const res = await request(app.getHttpServer())
        .delete(`/videos/${initiated.public_id}/uploads`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(409);
      expect((res.body as ErrorResponse).error).toBe('INVALID_VIDEO_STATUS');

      const row = await dataSource.query<VideoRow[]>(
        'SELECT * FROM "videos" WHERE "public_id" = $1',
        [initiated.public_id],
      );
      expect(row[0].status).toBe('uploaded');
      expect(row[0].storage_key).toBeTruthy();
    });

    it('rejects aborting a video from another channel', async () => {
      const ownerToken = await registerConfirmAndLogin(
        'abort-owner2@example.com',
      );
      const initiated = await initiate(ownerToken);

      const intruderToken = await registerConfirmAndLogin(
        'abort-intruder@example.com',
      );

      const res = await request(app.getHttpServer())
        .delete(`/videos/${initiated.public_id}/uploads`)
        .set('Authorization', `Bearer ${intruderToken}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorResponse).error).toBe('VIDEO_NOT_FOUND');

      const row = await dataSource.query<VideoRow[]>(
        'SELECT * FROM "videos" WHERE "public_id" = $1',
        [initiated.public_id],
      );
      expect(row).toHaveLength(1);
      expect(row[0].status).toBe('draft');
    });

    it('requires authentication', async () => {
      const accessToken = await registerConfirmAndLogin(
        'abort-auth@example.com',
      );
      const initiated = await initiate(accessToken);

      const res = await request(app.getHttpServer()).delete(
        `/videos/${initiated.public_id}/uploads`,
      );

      expect(res.status).toBe(401);

      const row = await dataSource.query<VideoRow[]>(
        'SELECT * FROM "videos" WHERE "public_id" = $1',
        [initiated.public_id],
      );
      expect(row).toHaveLength(1);
    });
  });
});
