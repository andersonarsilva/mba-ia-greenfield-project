import { DataSource, Repository } from 'typeorm';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as amqp from 'amqplib';
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
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10000,
  intervalMs = 300,
): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`pollUntil timed out. Last value: ${JSON.stringify(last)}`);
}

describe('Videos upload → queue flow (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let service: VideosService;
  let queueService: QueueService;
  let consumerConn: amqp.ChannelModel;
  let consumerChannel: amqp.Channel;

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
        { provide: getRepositoryToken(Video), useValue: videoRepository },
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

    consumerConn = await amqp.connect(process.env.QUEUE_URL as string);
    consumerChannel = await consumerConn.createChannel();
  }, 30000);

  afterAll(async () => {
    await consumerChannel.close();
    await consumerConn.close();
    await queueService.onModuleDestroy();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    // Purge stray messages from other test files so this suite counts only its own.
    await consumerChannel.purgeQueue(process.env.QUEUE_NAME as string);
  });

  let userCounter = 0;
  async function createUserWithChannel(): Promise<User> {
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_flow_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepository.save(
      channelRepository.create({
        name: `Channel ${userCounter}`,
        nickname: `flow_chan_${userCounter}`,
        user_id: user.id,
      }),
    );
    return user;
  }

  function makeDto(): InitiateUploadDto {
    return {
      title: 'Flow video',
      filename: 'movie.mp4',
      size_bytes: 1024,
      content_type: 'video/mp4',
    };
  }

  async function uploadAllParts(
    parts: { partNumber: number; url: string }[],
  ): Promise<CompleteUploadDto> {
    const uploaded: { part_number: number; etag: string }[] = [];
    for (const part of parts) {
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.from('flow content')),
      });
      uploaded.push({
        part_number: part.partNumber,
        etag: res.headers.get('etag') as string,
      });
    }
    return { parts: uploaded };
  }

  it('should publish exactly one video.process message with the correct videoId and storageKey on complete', async () => {
    const user = await createUserWithChannel();
    const initiated = await service.initiateUpload(user.id, makeDto());
    const completeDto = await uploadAllParts(initiated.parts);

    const received: unknown[] = [];
    await consumerChannel.consume(process.env.QUEUE_NAME as string, (msg) => {
      if (!msg) return;
      received.push(JSON.parse(msg.content.toString()));
      consumerChannel.ack(msg);
    });

    await service.completeUpload(user.id, initiated.public_id, completeDto);

    await pollUntil(
      () => Promise.resolve(received.length),
      (count) => count > 0,
    );

    // Give a bit of slack to make sure no duplicate arrives.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      videoId: initiated.id,
      storageKey: expect.stringContaining(`videos/${initiated.id}/`) as string,
    });
  }, 20000);
});
