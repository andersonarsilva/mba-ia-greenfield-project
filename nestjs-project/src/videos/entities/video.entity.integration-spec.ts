import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let userCounter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${++userCounter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${userCounter}`,
        nickname: `chan_${userCounter}`,
        user_id: user.id,
      }),
    );
  }

  function baseVideo(channelId: string, publicId: string) {
    return { title: 'My video', channel_id: channelId, public_id: publicId };
  }

  it('should enforce unique public_id constraint', async () => {
    const channel = await createChannel();

    await videoRepository.save(
      videoRepository.create(baseVideo(channel.id, 'dup-id-0001')),
    );

    await expect(
      videoRepository.save(
        videoRepository.create(baseVideo(channel.id, 'dup-id-0001')),
      ),
    ).rejects.toThrow();
  });

  it('should default status to draft when not explicitly set', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create(baseVideo(channel.id, 'default-st1')),
    );

    expect(video.status).toBe('draft');
  });

  it('should enforce foreign key to channels', async () => {
    await expect(
      videoRepository.save(
        videoRepository.create(
          baseVideo('00000000-0000-0000-0000-000000000000', 'no-channel1'),
        ),
      ),
    ).rejects.toThrow();
  });

  it('should allow null metadata columns', async () => {
    const channel = await createChannel();

    const video = await videoRepository.save(
      videoRepository.create(baseVideo(channel.id, 'null-meta01')),
    );

    expect(video.storage_key).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.upload_id).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.width).toBeNull();
    expect(video.height).toBeNull();
    expect(video.codec).toBeNull();
    expect(video.container).toBeNull();
    expect(video.size_bytes).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.error_reason).toBeNull();
  });
});
