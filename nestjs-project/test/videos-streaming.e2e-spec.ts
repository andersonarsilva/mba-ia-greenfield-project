import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
  public_id: string;
  parts: { partNumber: number; url: string }[];
}

interface ErrorResponse {
  error: string;
}

const execFileAsync = promisify(execFile);

// A short stream-URL expiration lets the "expired URL" scenario run in a few
// seconds instead of waiting out the real 300s default — set before AppModule
// bootstraps so ConfigModule picks it up.
process.env.STORAGE_STREAM_URL_EXPIRATION_SECONDS = '2';

describe('videos-streaming (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let fixtureDir: string;
  let fixtureBuffer: Buffer;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'stream-e2e-fixture-'));
    const fixturePath = join(fixtureDir, 'fixture.mp4');
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=2:size=64x64:rate=5',
        '-pix_fmt',
        'yuv420p',
        fixturePath,
      ],
      { timeout: 30000 },
    );
    fixtureBuffer = await readFile(fixturePath);

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
  }, 60000);

  afterAll(async () => {
    await app.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
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

  async function pollUntilReady(
    publicId: string,
    timeoutMs = 25000,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const rows = await dataSource.query<
        { status: string; error_reason: string | null }[]
      >('SELECT status, error_reason FROM "videos" WHERE "public_id" = $1', [
        publicId,
      ]);
      if (rows[0]?.status === 'ready') return;
      if (rows[0]?.status === 'error') {
        throw new Error(`Video processing failed: ${JSON.stringify(rows[0])}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Timed out waiting for video ${publicId} to become ready`);
  }

  async function createReadyVideo(
    accessToken: string,
    title = 'My video',
  ): Promise<string> {
    const initiateRes = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title,
        filename: 'fixture.mp4',
        size_bytes: fixtureBuffer.length,
        content_type: 'video/mp4',
      });
    const initiated = initiateRes.body as InitiateUploadResponse;

    const parts: { part_number: number; etag: string | null }[] = [];
    for (const part of initiated.parts) {
      const putRes = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(fixtureBuffer),
      });
      parts.push({
        part_number: part.partNumber,
        etag: putRes.headers.get('etag'),
      });
    }

    await request(app.getHttpServer())
      .post(`/videos/${initiated.public_id}/uploads/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts });

    // The already-running video-worker container consumes the job and
    // processes it with real ffprobe/ffmpeg.
    await pollUntilReady(initiated.public_id);

    return initiated.public_id;
  }

  async function createVideoWithStatus(
    accessToken: string,
    status: string,
  ): Promise<string> {
    const initiateRes = await request(app.getHttpServer())
      .post('/videos/uploads')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Non-ready video',
        filename: 'fixture.mp4',
        size_bytes: 1024,
        content_type: 'video/mp4',
      });
    const publicId = (initiateRes.body as InitiateUploadResponse).public_id;
    await dataSource.query(
      'UPDATE "videos" SET status = $1 WHERE "public_id" = $2',
      [status, publicId],
    );
    return publicId;
  }

  describe('GET /videos/:publicId/stream', () => {
    it('redirects with 302 to a presigned URL and carries no video bytes', async () => {
      const accessToken = await registerConfirmAndLogin('stream1@example.com');
      const publicId = await createReadyVideo(accessToken);

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .redirects(0);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBeTruthy();
      expect(res.headers.location).toContain('X-Amz-Signature');
      expect(Buffer.byteLength(res.text ?? '')).toBeLessThan(1000);
    }, 30000);

    it('serves Range requests as 206 with the exact requested slice', async () => {
      const accessToken = await registerConfirmAndLogin('stream2@example.com');
      const publicId = await createReadyVideo(accessToken);

      const streamRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .redirects(0);
      const url = streamRes.headers.location;

      const first = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      const firstBody = Buffer.from(await first.arrayBuffer());
      expect(first.status).toBe(206);
      expect(first.headers.get('content-range')).toContain(
        `/${fixtureBuffer.length}`,
      );
      expect(firstBody).toEqual(fixtureBuffer.subarray(0, 1024));

      const second = await fetch(url, {
        headers: { Range: 'bytes=1024-2047' },
      });
      const secondBody = Buffer.from(await second.arrayBuffer());
      expect(second.status).toBe(206);
      expect(secondBody).toEqual(fixtureBuffer.subarray(1024, 2048));
    }, 30000);

    it('rejects streaming a video that is not ready', async () => {
      const accessToken = await registerConfirmAndLogin('stream3@example.com');
      const draftId = await createVideoWithStatus(accessToken, 'draft');
      const errorId = await createVideoWithStatus(accessToken, 'error');

      const draftRes = await request(app.getHttpServer())
        .get(`/videos/${draftId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(draftRes.status).toBe(409);
      expect((draftRes.body as ErrorResponse).error).toBe('VIDEO_NOT_READY');

      const errorRes = await request(app.getHttpServer())
        .get(`/videos/${errorId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`);
      expect(errorRes.status).toBe(409);
      expect((errorRes.body as ErrorResponse).error).toBe('VIDEO_NOT_READY');
    });

    it('rejects streaming for another channel and requires authentication', async () => {
      const ownerToken = await registerConfirmAndLogin('stream4@example.com');
      const publicId = await createReadyVideo(ownerToken);
      const intruderToken = await registerConfirmAndLogin(
        'stream4-intruder@example.com',
      );

      const intruderRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${intruderToken}`);
      expect(intruderRes.status).toBe(404);
      expect((intruderRes.body as ErrorResponse).error).toBe('VIDEO_NOT_FOUND');

      const noAuthRes = await request(app.getHttpServer()).get(
        `/videos/${publicId}/stream`,
      );
      expect(noAuthRes.status).toBe(401);
    }, 30000);

    it('rejects access to an expired signed URL', async () => {
      const accessToken = await registerConfirmAndLogin('stream5@example.com');
      const publicId = await createReadyVideo(accessToken);

      const streamRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/stream`)
        .set('Authorization', `Bearer ${accessToken}`)
        .redirects(0);
      const url = streamRes.headers.location;

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const expiredRes = await fetch(url);
      expect(expiredRes.status).toBeGreaterThanOrEqual(400);
    }, 30000);
  });

  describe('GET /videos/:publicId/download', () => {
    it('redirects with an attachment Content-Disposition derived from the title', async () => {
      const accessToken = await registerConfirmAndLogin(
        'download1@example.com',
      );
      const publicId = await createReadyVideo(
        accessToken,
        'Meu Vídeo Incrível',
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .set('Authorization', `Bearer ${accessToken}`)
        .redirects(0);

      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(location).toContain('attachment');
      expect(location).toContain('Meu-Video-Incrivel.mp4');

      const downloadRes = await fetch(location);
      expect(downloadRes.headers.get('content-disposition')).toContain(
        'attachment',
      );
      expect(downloadRes.headers.get('content-disposition')).toContain(
        'Meu-Video-Incrivel.mp4',
      );
      const body = Buffer.from(await downloadRes.arrayBuffer());
      expect(body).toEqual(fixtureBuffer);
    }, 30000);

    it('rejects downloading a video that is not ready', async () => {
      const accessToken = await registerConfirmAndLogin(
        'download2@example.com',
      );
      const processingId = await createVideoWithStatus(
        accessToken,
        'processing',
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${processingId}/download`)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(409);
      expect((res.body as ErrorResponse).error).toBe('VIDEO_NOT_READY');
    });

    it('rejects downloading for another channel and requires authentication', async () => {
      const ownerToken = await registerConfirmAndLogin('download3@example.com');
      const publicId = await createReadyVideo(ownerToken);
      const intruderToken = await registerConfirmAndLogin(
        'download3-intruder@example.com',
      );

      const intruderRes = await request(app.getHttpServer())
        .get(`/videos/${publicId}/download`)
        .set('Authorization', `Bearer ${intruderToken}`);
      expect(intruderRes.status).toBe(404);
      expect((intruderRes.body as ErrorResponse).error).toBe('VIDEO_NOT_FOUND');

      const noAuthRes = await request(app.getHttpServer()).get(
        `/videos/${publicId}/download`,
      );
      expect(noAuthRes.status).toBe(401);
    }, 30000);
  });
});
