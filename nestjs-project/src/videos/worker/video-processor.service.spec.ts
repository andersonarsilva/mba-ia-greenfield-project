jest.mock('./ffprobe');
jest.mock('./thumbnail');

import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { probeVideo } from './ffprobe';
import { extractThumbnail } from './thumbnail';
import { VideoProcessorService } from './video-processor.service';

const mockProbeVideo = probeVideo as jest.MockedFunction<typeof probeVideo>;
const mockExtractThumbnail = extractThumbnail as jest.MockedFunction<
  typeof extractThumbnail
>;

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    public_id: 'abc123def45',
    channel_id: 'channel-1',
    title: 'My video',
    status: 'uploaded',
    storage_key: 'videos/video-1/original.mp4',
    thumbnail_key: null,
    upload_id: null,
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

describe('VideoProcessorService', () => {
  let service: VideoProcessorService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let storageService: jest.Mocked<StorageService>;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessorService,
        {
          provide: getRepositoryToken(Video),
          useValue: { findOne: jest.fn(), save: jest.fn((v: Video) => v) },
        },
        {
          provide: StorageService,
          useValue: { downloadToFile: jest.fn(), uploadFile: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(VideoProcessorService);
    videoRepository = module.get(getRepositoryToken(Video));
    storageService = module.get(StorageService);
  });

  it('should skip processing when the video is already ready (idempotent redelivery)', async () => {
    videoRepository.findOne.mockResolvedValue(makeVideo({ status: 'ready' }));

    await service.process({ videoId: 'video-1', storageKey: 'k' });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(storageService.downloadToFile).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(storageService.uploadFile).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('should skip processing when the video is already in error', async () => {
    videoRepository.findOne.mockResolvedValue(makeVideo({ status: 'error' }));

    await service.process({ videoId: 'video-1', storageKey: 'k' });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(storageService.downloadToFile).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(videoRepository.save).not.toHaveBeenCalled();
  });

  it('should process a video in uploaded status and transition it to ready', async () => {
    videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: 'uploaded' }),
    );
    mockProbeVideo.mockResolvedValue({
      durationSeconds: 10,
      width: 640,
      height: 480,
      codec: 'h264',
      container: 'mov,mp4',
      sizeBytes: 1024,
      raw: { format: { duration: '10' } },
    });
    mockExtractThumbnail.mockResolvedValue(undefined);

    await service.process({
      videoId: 'video-1',
      storageKey: 'videos/video-1/original.mp4',
    });

    const savedCalls = videoRepository.save.mock.calls.map(
      (c) => c[0] as Video,
    );
    const readySave = savedCalls.find((v) => v.status === 'ready');
    expect(readySave).toBeDefined();
    expect(readySave!.duration_seconds).toBe(10);
    expect(readySave!.width).toBe(640);
    expect(readySave!.thumbnail_key).toBe('videos/video-1/thumbnail.jpg');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(storageService.uploadFile).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      expect.any(String),
      'image/jpeg',
    );
  });

  it('should transition to error with a reason when processing fails', async () => {
    videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: 'uploaded' }),
    );
    mockProbeVideo.mockRejectedValue(new Error('ffprobe failed: invalid data'));

    await expect(
      service.process({ videoId: 'video-1', storageKey: 'k' }),
    ).rejects.toThrow('ffprobe failed: invalid data');

    const savedCalls = videoRepository.save.mock.calls.map(
      (c) => c[0] as Video,
    );
    const errorSave = savedCalls.find((v) => v.status === 'error');
    expect(errorSave).toBeDefined();
    expect(errorSave!.error_reason).toBe('ffprobe failed: invalid data');
  });

  it('should reprocess a video stuck in processing (worker crash recovery)', async () => {
    videoRepository.findOne.mockResolvedValue(
      makeVideo({ status: 'processing' }),
    );
    mockProbeVideo.mockResolvedValue({
      durationSeconds: 5,
      width: null,
      height: null,
      codec: null,
      container: null,
      sizeBytes: 0,
      raw: {},
    });
    mockExtractThumbnail.mockResolvedValue(undefined);

    await service.process({ videoId: 'video-1', storageKey: 'k' });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(storageService.downloadToFile).toHaveBeenCalled();
  });
});
