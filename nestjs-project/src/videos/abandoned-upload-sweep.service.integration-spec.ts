import { DataSource, Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { getOriginalKey } from '../storage/storage.keys';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { AbandonedUploadSweepService } from './abandoned-upload-sweep.service';
import { Video } from './entities/video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const EXPIRATION_HOURS = 1;

describe('AbandonedUploadSweepService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let service: AbandonedUploadSweepService;
  let rawS3Client: S3Client;
  let bucket: string;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [
        AbandonedUploadSweepService,
        StorageService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        {
          provide: videosConfig.KEY,
          useValue: { abandonedUploadExpirationHours: EXPIRATION_HOURS },
        },
      ],
    }).compile();

    service = module.get(AbandonedUploadSweepService);
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
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createDraftWithOpenUpload(ageHours: number): Promise<Video> {
    const counter = ++userCounter;
    const user = await userRepository.save(
      userRepository.create({
        email: `sweep_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Sweep Channel ${counter}`,
        nickname: `sweep_chan_${counter}`,
        user_id: user.id,
      }),
    );

    const storageKey = getOriginalKey(`sweep-fixture-${counter}`, 'f.mp4');
    const { uploadId } = await storageService.createMultipartUpload(storageKey);

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `sweep0000${counter}`.slice(0, 11),
        channel_id: channel.id,
        title: 'Abandoned upload fixture',
        status: 'draft',
        storage_key: storageKey,
        upload_id: uploadId,
      }),
    );

    await dataSource.query(
      `UPDATE "videos" SET created_at = now() - interval '${ageHours} hours' WHERE id = $1`,
      [video.id],
    );

    return video;
  }

  it('should mark an old abandoned draft as error and abort its multipart upload', async () => {
    const video = await createDraftWithOpenUpload(EXPIRATION_HOURS + 1);

    await service.expireAbandonedDrafts();

    const stored = await videoRepository.findOne({ where: { id: video.id } });
    expect(stored!.status).toBe('error');
    expect(stored!.error_reason).toBeTruthy();
    expect(stored!.upload_id).toBeNull();

    await expect(
      rawS3Client.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: video.storage_key as string,
          UploadId: video.upload_id as string,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should leave a draft within the window untouched', async () => {
    const video = await createDraftWithOpenUpload(0);

    await service.expireAbandonedDrafts();

    const stored = await videoRepository.findOne({ where: { id: video.id } });
    expect(stored!.status).toBe('draft');
    expect(stored!.upload_id).toBe(video.upload_id);

    await expect(
      rawS3Client.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: video.storage_key as string,
          UploadId: video.upload_id as string,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('should be idempotent across consecutive runs', async () => {
    const video = await createDraftWithOpenUpload(EXPIRATION_HOURS + 1);

    await service.expireAbandonedDrafts();
    await service.expireAbandonedDrafts();

    const stored = await videoRepository.findOne({ where: { id: video.id } });
    expect(stored!.status).toBe('error');
  });
});
