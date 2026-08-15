import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { getOriginalKey } from '../storage/storage.keys';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Videos streaming (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let service: VideosService;
  const fixtureContent = Buffer.from('0123456789'.repeat(200)); // 2000 bytes

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
        VideosService,
        StorageService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        {
          provide: ChannelsService,
          useValue: {
            findByUserId: (userId: string) =>
              channelRepository.findOne({ where: { user_id: userId } }),
          },
        },
        // getStreamUrl/getDownloadUrl never touch the queue or the DataSource
        // transaction path — stub both so VideosService's DI graph resolves.
        { provide: QueueService, useValue: {} },
        { provide: DataSource, useValue: {} },
      ],
    }).compile();

    service = module.get(VideosService);
    storageService = module.get(StorageService);
  }, 30000);

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createReadyVideo(): Promise<{ video: Video; user: User }> {
    const counter = ++userCounter;
    const user = await userRepository.save(
      userRepository.create({
        email: `stream_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `stream_chan_${counter}`,
        user_id: user.id,
      }),
    );

    const storageKey = getOriginalKey(
      `stream-fixture-${counter}`,
      'fixture.mp4',
    );
    await storageService.uploadFile(
      storageKey,
      await writeFixtureFile(),
      'video/mp4',
    );

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: `stream000${counter}`.slice(0, 11),
        channel_id: channel.id,
        title: 'Streaming fixture',
        status: 'ready',
        storage_key: storageKey,
      }),
    );
    return { video, user };
  }

  async function writeFixtureFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'stream-fixture-'));
    const filePath = join(dir, 'fixture.mp4');
    await writeFile(filePath, fixtureContent);
    return filePath;
  }

  it('should emit a signed URL that serves a Range request as 206 with the exact requested slice', async () => {
    const { video, user } = await createReadyVideo();

    const url = await service.getStreamUrl(user.id, video.public_id);

    const rangeResponse = await fetch(url, {
      headers: { Range: 'bytes=0-1023' },
    });
    const body = Buffer.from(await rangeResponse.arrayBuffer());

    expect(rangeResponse.status).toBe(206);
    expect(body).toEqual(fixtureContent.subarray(0, 1024));
    expect(body.length).toBe(1024);
  });

  it('should serve a non-initial Range without requiring the full object', async () => {
    const { video, user } = await createReadyVideo();

    const url = await service.getStreamUrl(user.id, video.public_id);

    const rangeResponse = await fetch(url, {
      headers: { Range: 'bytes=1000-1499' },
    });
    const body = Buffer.from(await rangeResponse.arrayBuffer());

    expect(rangeResponse.status).toBe(206);
    expect(body).toEqual(fixtureContent.subarray(1000, 1500));
  });
});
