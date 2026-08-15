import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { AbandonedUploadSweepService } from './abandoned-upload-sweep.service';
import { Video } from './entities/video.entity';
import { VIDEO_STATUS } from './videos.constants';

const EXPIRATION_HOURS = 24;

function makeDraftVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    public_id: 'abc123def45',
    channel_id: 'channel-1',
    title: 'Abandoned upload',
    status: 'draft',
    storage_key: 'videos/video-1/original.mp4',
    thumbnail_key: null,
    upload_id: 'upload-1',
    duration_seconds: null,
    width: null,
    height: null,
    codec: null,
    container: null,
    size_bytes: null,
    metadata: null,
    error_reason: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as unknown as Video['channel'],
    ...overrides,
  };
}

describe('AbandonedUploadSweepService', () => {
  let service: AbandonedUploadSweepService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let storageService: jest.Mocked<StorageService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AbandonedUploadSweepService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            find: jest.fn(),
            save: jest.fn((video: Video) => Promise.resolve(video)),
          },
        },
        {
          provide: StorageService,
          useValue: { abortMultipartUpload: jest.fn() },
        },
        {
          provide: videosConfig.KEY,
          useValue: { abandonedUploadExpirationHours: EXPIRATION_HOURS },
        },
      ],
    }).compile();

    service = module.get(AbandonedUploadSweepService);
    videoRepository = module.get(getRepositoryToken(Video));
    storageService = module.get(StorageService);
  });

  it('should not touch storage or the row when no draft is past the window', async () => {
    videoRepository.find.mockResolvedValue([]);

    await service.expireAbandonedDrafts();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('should abort the multipart upload and mark the draft as error when past the window', async () => {
    const oldDraft = makeDraftVideo();
    videoRepository.find.mockResolvedValue([oldDraft]);

    await service.expireAbandonedDrafts();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original.mp4',
      'upload-1',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(videoRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'video-1',
        status: VIDEO_STATUS.ERROR,
        upload_id: null,
      }),
    );
    const saved = videoRepository.save.mock.calls[0][0] as Video;
    expect(saved.error_reason).toBeTruthy();
  });

  it('should not save when aborting the multipart upload fails', async () => {
    const oldDraft = makeDraftVideo();
    videoRepository.find.mockResolvedValue([oldDraft]);
    storageService.abortMultipartUpload.mockRejectedValue(
      new Error('storage unavailable'),
    );

    await service.expireAbandonedDrafts();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('should query with a cutoff derived from the configured expiration window', async () => {
    videoRepository.find.mockResolvedValue([]);
    const before = Date.now();

    await service.expireAbandonedDrafts();

    const after = Date.now();
    const where = videoRepository.find.mock.calls[0][0]!.where as {
      status: string;
      created_at: { value: Date };
    };
    expect(where.status).toBe(VIDEO_STATUS.DRAFT);
    const cutoffMs = where.created_at.value.getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(
      before - EXPIRATION_HOURS * 60 * 60 * 1000 - 1000,
    );
    expect(cutoffMs).toBeLessThanOrEqual(
      after - EXPIRATION_HOURS * 60 * 60 * 1000 + 1000,
    );
  });
});
