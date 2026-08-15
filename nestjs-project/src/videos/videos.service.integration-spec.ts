import { DataSource, Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ListPartsCommand, S3Client } from '@aws-sdk/client-s3';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import { InvalidVideoStatusException } from '../common/exceptions/domain.exception';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let service: VideosService;
  let queueService: QueueService;
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
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
      ],
      providers: [
        VideosService,
        StorageService,
        QueueService,
        { provide: DataSource, useValue: dataSource },
        {
          provide: getRepositoryToken(Video),
          useValue: videoRepository,
        },
        {
          provide: ChannelsService,
          useValue: {
            findByUserId: (userId: string) =>
              channelRepository.findOne({ where: { user_id: userId } }),
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
    queueService = module.get(QueueService);
    await queueService.onModuleInit();

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
    await queueService.onModuleDestroy();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${userCounter}`,
        nickname: `svc_chan_${userCounter}`,
        user_id: user.id,
      }),
    );
    return { user, channel };
  }

  function makeDto(): InitiateUploadDto {
    return {
      title: 'Integration video',
      filename: 'movie.mp4',
      size_bytes: 1024,
      content_type: 'video/mp4',
    };
  }

  async function uploadAllParts(
    parts: { partNumber: number; url: string }[],
    content: Buffer,
  ): Promise<CompleteUploadDto> {
    const uploaded: { part_number: number; etag: string }[] = [];
    for (const part of parts) {
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(content),
      });
      uploaded.push({
        part_number: part.partNumber,
        etag: res.headers.get('etag') as string,
      });
    }
    return { parts: uploaded };
  }

  it('should persist a draft row with a unique public_id linked to the caller channel', async () => {
    const { user, channel } = await createUserWithChannel();

    const result = await service.initiateUpload(user.id, makeDto());

    const stored = await videoRepository.findOne({
      where: { id: result.id },
    });
    expect(stored).not.toBeNull();
    expect(stored!.public_id).toHaveLength(11);
    expect(stored!.channel_id).toBe(channel.id);
    expect(stored!.status).toBe('draft');
  });

  it('should generate distinct public_ids across consecutive uploads', async () => {
    const { user } = await createUserWithChannel();

    const first = await service.initiateUpload(user.id, makeDto());
    const second = await service.initiateUpload(user.id, makeDto());

    expect(first.public_id).not.toBe(second.public_id);
  });

  it('should transition draft to uploaded with storage_key filled and upload_id cleared on complete', async () => {
    const { user } = await createUserWithChannel();
    const initiated = await service.initiateUpload(user.id, makeDto());
    const completeDto = await uploadAllParts(
      initiated.parts,
      Buffer.from('hello integration'),
    );

    const completed = await service.completeUpload(
      user.id,
      initiated.public_id,
      completeDto,
    );

    expect(completed.status).toBe('uploaded');
    const stored = await videoRepository.findOne({
      where: { id: initiated.id },
    });
    expect(stored!.status).toBe('uploaded');
    expect(stored!.storage_key).toBeTruthy();
    expect(stored!.upload_id).toBeNull();
  });

  it('should reject completing a video that is not in draft', async () => {
    const { user } = await createUserWithChannel();
    const initiated = await service.initiateUpload(user.id, makeDto());
    const completeDto = await uploadAllParts(
      initiated.parts,
      Buffer.from('hello integration'),
    );
    await service.completeUpload(user.id, initiated.public_id, completeDto);

    await expect(
      service.completeUpload(user.id, initiated.public_id, completeDto),
    ).rejects.toThrow(InvalidVideoStatusException);
  });

  it('should abort the multipart upload and remove the draft row', async () => {
    const { user } = await createUserWithChannel();
    const initiated = await service.initiateUpload(user.id, makeDto());
    const beforeAbort = await videoRepository.findOne({
      where: { id: initiated.id },
    });
    const storageKey = beforeAbort!.storage_key as string;
    await fetch(initiated.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('partial'),
    });

    await service.abortUpload(user.id, initiated.public_id);

    const stored = await videoRepository.findOne({
      where: { id: initiated.id },
    });
    expect(stored).toBeNull();

    await expect(
      rawS3Client.send(
        new ListPartsCommand({
          Bucket: bucket,
          Key: storageKey,
          UploadId: initiated.upload_id,
        }),
      ),
    ).rejects.toThrow();
  });
});
