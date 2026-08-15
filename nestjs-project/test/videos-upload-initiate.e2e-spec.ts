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
  status: string;
  upload_id: string | null;
  part_size_bytes: number;
  parts: { partNumber: number; url: string }[];
}

interface VideoDetailResponse {
  public_id: string;
  title: string;
  status: string;
  created_at: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  container: string | null;
  size_bytes: number | null;
}

interface ErrorResponse {
  error: string;
}

interface VideoRow {
  status: string;
}

describe('videos-upload-initiate (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

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

  describe('POST /videos/uploads', () => {
    it('initiates an upload with a valid payload', async () => {
      const accessToken = await registerConfirmAndLogin('init1@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validPayload());

      const initiated = res.body as InitiateUploadResponse;
      expect(res.status).toBe(201);
      expect(initiated.public_id).toHaveLength(11);
      expect(initiated.public_id).toMatch(/^[0-9A-Za-z_-]+$/);
      expect(initiated.status).toBe('draft');
      expect(initiated.upload_id).toBeTruthy();
      expect(typeof initiated.part_size_bytes).toBe('number');
      expect(initiated.part_size_bytes).toBeGreaterThan(0);
      expect(Array.isArray(initiated.parts)).toBe(true);
      expect(initiated.parts.length).toBeGreaterThan(0);
      expect(initiated.parts[0]).toHaveProperty('partNumber');
      expect(initiated.parts[0]).toHaveProperty('url');

      const row = await dataSource.query<VideoRow[]>(
        'SELECT * FROM "videos" WHERE "public_id" = $1',
        [initiated.public_id],
      );
      expect(row).toHaveLength(1);
      expect(row[0].status).toBe('draft');
    });

    it('rejects a file above the 10GB limit', async () => {
      const accessToken = await registerConfirmAndLogin('toolarge@example.com');

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validPayload({ size_bytes: 10737418240 + 1 }));

      expect(res.status).toBe(413);
      expect((res.body as ErrorResponse).error).toBe('FILE_TOO_LARGE');

      const rows = await dataSource.query<VideoRow[]>('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });

    it('rejects an unsupported content_type', async () => {
      const accessToken = await registerConfirmAndLogin(
        'unsupported@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validPayload({ content_type: 'application/zip' }));

      expect(res.status).toBe(415);
      expect((res.body as ErrorResponse).error).toBe('UNSUPPORTED_MEDIA_TYPE');

      const rows = await dataSource.query<VideoRow[]>('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });

    it('rejects an invalid payload', async () => {
      const accessToken = await registerConfirmAndLogin(
        'invalidpayload@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: '', filename: 'movie.mp4', content_type: 'video/mp4' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorResponse).error).toBe('VALIDATION_ERROR');
    });

    it('requires authentication', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .send(validPayload());

      expect(res.status).toBe(401);

      const rows = await dataSource.query<VideoRow[]>('SELECT * FROM "videos"');
      expect(rows).toHaveLength(0);
    });
  });

  describe('GET /videos/:publicId', () => {
    it('lets the owner fetch their own video', async () => {
      const accessToken = await registerConfirmAndLogin('owner@example.com');
      const created = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validPayload());

      const res = await request(app.getHttpServer())
        .get(`/videos/${(created.body as InitiateUploadResponse).public_id}`)
        .set('Authorization', `Bearer ${accessToken}`);

      const detail = res.body as VideoDetailResponse;
      expect(res.status).toBe(200);
      expect(detail.public_id).toBe(
        (created.body as InitiateUploadResponse).public_id,
      );
      expect(detail.title).toBe('My video');
      expect(detail.status).toBe('draft');
      expect(detail.created_at).toBeDefined();
      expect(detail.duration_seconds).toBeNull();
      expect(detail.width).toBeNull();
      expect(detail.height).toBeNull();
      expect(detail.codec).toBeNull();
      expect(detail.container).toBeNull();
      expect(detail.size_bytes).toBeNull();
    });

    it('returns an indistinguishable 404 for another channel video and for a nonexistent publicId', async () => {
      const ownerToken = await registerConfirmAndLogin('owner2@example.com');
      const created = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send(validPayload());

      const intruderToken = await registerConfirmAndLogin(
        'intruder@example.com',
      );

      const otherChannelRes = await request(app.getHttpServer())
        .get(`/videos/${(created.body as InitiateUploadResponse).public_id}`)
        .set('Authorization', `Bearer ${intruderToken}`);
      expect(otherChannelRes.status).toBe(404);
      expect((otherChannelRes.body as ErrorResponse).error).toBe(
        'VIDEO_NOT_FOUND',
      );

      const nonexistentRes = await request(app.getHttpServer())
        .get('/videos/aaaaaaaaaaa')
        .set('Authorization', `Bearer ${intruderToken}`);
      expect(nonexistentRes.status).toBe(404);
      expect((nonexistentRes.body as ErrorResponse).error).toBe(
        'VIDEO_NOT_FOUND',
      );
      expect(nonexistentRes.body).toEqual(otherChannelRes.body);
    });

    it('requires authentication', async () => {
      const res = await request(app.getHttpServer()).get('/videos/aaaaaaaaaaa');

      expect(res.status).toBe(401);
    });
  });
});
