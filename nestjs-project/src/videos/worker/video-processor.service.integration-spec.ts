import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import { getOriginalKey, getThumbnailKey } from '../../storage/storage.keys';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideoProcessorService } from './video-processor.service';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessorService (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channelRepository: Repository<Channel>;
  let userRepository: Repository<User>;
  let service: VideoProcessorService;
  let storageService: StorageService;
  let rawS3Client: S3Client;
  let bucket: string;
  let fixtureDir: string;
  let fixturePath: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
    channelRepository = dataSource.getRepository(Channel);
    userRepository = dataSource.getRepository(User);

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [
        VideoProcessorService,
        StorageService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
      ],
    }).compile();

    service = module.get(VideoProcessorService);
    storageService = module.get(StorageService);

    bucket = process.env.STORAGE_BUCKET as string;
    rawS3Client = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT,
      region: process.env.STORAGE_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY as string,
      },
    });

    // Generate a tiny synthetic video fixture via ffmpeg's built-in test source —
    // avoids committing a binary fixture file to the repo.
    fixtureDir = await mkdtemp(join(tmpdir(), 'video-fixture-'));
    fixturePath = join(fixtureDir, 'fixture.mp4');
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=3:size=64x64:rate=5',
        '-pix_fmt',
        'yuv420p',
        fixturePath,
      ],
      { timeout: 30000 },
    );
  }, 60000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUploadedVideo(): Promise<Video> {
    const counter = ++userCounter;
    const user = await userRepository.save(
      userRepository.create({
        email: `processor_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `proc_chan_${counter}`,
        user_id: user.id,
      }),
    );

    const id = randomUUID();
    const storageKey = getOriginalKey(id, 'fixture.mp4');
    await storageService.uploadFile(storageKey, fixturePath, 'video/mp4');

    return videoRepository.save(
      videoRepository.create({
        id,
        public_id: `fx${String(counter).padStart(9, '0')}`,
        channel_id: channel.id,
        title: 'Fixture video',
        status: 'uploaded',
        storage_key: storageKey,
      }),
    );
  }

  it('should process a valid video to ready with metadata and thumbnail', async () => {
    const video = await createUploadedVideo();

    await service.process({
      videoId: video.id,
      storageKey: video.storage_key as string,
    });

    const stored = await videoRepository.findOne({
      where: { id: video.id },
    });
    expect(stored!.status).toBe('ready');
    expect(stored!.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(stored!.width).toBe(64);
    expect(stored!.height).toBe(64);
    expect(stored!.codec).toBeTruthy();
    expect(stored!.metadata).toBeTruthy();
    expect(stored!.thumbnail_key).toBe(getThumbnailKey(video.id));

    const head = await rawS3Client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: stored!.thumbnail_key as string,
      }),
    );
    expect(head.ContentLength).toBeGreaterThan(0);
  }, 30000);
});
