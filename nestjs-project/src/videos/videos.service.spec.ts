import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import {
  FileTooLargeException,
  InvalidVideoStatusException,
  UnsupportedMediaTypeException,
  UploadExpiredException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { StorageService } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

function makeChannel(): Channel {
  const channel = new Channel();
  channel.id = 'channel-1';
  return channel;
}

function makeUniqueViolation(): QueryFailedError {
  const err = new QueryFailedError(
    'INSERT',
    [],
    new Error(),
  ) as QueryFailedError & {
    code: string;
    detail: string;
  };
  err.code = '23505';
  err.detail = 'Key (public_id)=(abc) already exists.';
  return err;
}

function makeDto(
  overrides: Partial<InitiateUploadDto> = {},
): InitiateUploadDto {
  return {
    title: 'My video',
    filename: 'movie.mp4',
    size_bytes: 1024,
    content_type: 'video/mp4',
    ...overrides,
  };
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-1',
    public_id: 'abc123def45',
    channel_id: 'channel-1',
    title: 'My video',
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
    channel: undefined as unknown as Channel,
    ...overrides,
  };
}

function makeStorageServiceMock() {
  return {
    createMultipartUpload: jest.fn(),
    signUploadParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    getSignedDownloadUrl: jest.fn(),
  };
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let channelsService: jest.Mocked<ChannelsService>;
  let storageService: ReturnType<typeof makeStorageServiceMock>;
  let queueService: jest.Mocked<QueueService>;
  let dataSource: { transaction: jest.Mock };
  let callOrder: string[];
  let managerFindOne: jest.Mock;
  let managerSave: jest.Mock;

  beforeEach(async () => {
    callOrder = [];
    managerFindOne = jest.fn();
    managerSave = jest.fn((video: Video) => {
      callOrder.push('save');
      return Promise.resolve(video);
    });
    dataSource = {
      transaction: jest.fn((cb: (manager: any) => Promise<any>) =>
        cb({ findOne: managerFindOne, save: managerSave }),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            create: jest.fn((input: Partial<Video>) => input),
            save: jest.fn(),
            findOne: jest.fn(),
            delete: jest.fn(),
          },
        },
        {
          provide: ChannelsService,
          useValue: { findByUserId: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: makeStorageServiceMock(),
        },
        {
          provide: QueueService,
          useValue: {
            publish: jest.fn(() => {
              callOrder.push('publish');
              return Promise.resolve();
            }),
          },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    channelsService = module.get(ChannelsService);
    storageService = module.get(StorageService);
    queueService = module.get(QueueService);

    channelsService.findByUserId.mockResolvedValue(makeChannel());
    storageService.createMultipartUpload.mockResolvedValue({
      uploadId: 'upload-1',
    });
    storageService.signUploadParts.mockResolvedValue([
      { partNumber: 1, url: 'https://signed-url' },
    ]);
  });

  describe('initiateUpload', () => {
    it('should throw FileTooLargeException when size_bytes exceeds 10GB and never touch storage', async () => {
      const dto = makeDto({ size_bytes: 10 * 1024 * 1024 * 1024 + 1 });

      await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
        FileTooLargeException,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should throw UnsupportedMediaTypeException for an unsupported content_type and never touch storage', async () => {
      const dto = makeDto({ content_type: 'application/zip' });

      await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
        UnsupportedMediaTypeException,
      );
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should retry with a fresh public_id when the first insert collides', async () => {
      const savedVideo = {
        id: 'video-1',
        public_id: 'retried-id-',
        status: 'draft',
      } as Video;
      videoRepository.save
        .mockRejectedValueOnce(makeUniqueViolation())
        .mockResolvedValueOnce(savedVideo);

      const result = await service.initiateUpload('user-1', makeDto());

      // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
      expect(videoRepository.save).toHaveBeenCalledTimes(2);
      expect(result.id).toBe('video-1');
      expect(result.status).toBe('draft');
      expect(result.upload_id).toBe('upload-1');
      expect(result.parts).toEqual([
        { partNumber: 1, url: 'https://signed-url' },
      ]);
    });
  });

  describe('completeUpload', () => {
    function makeCompleteDto(): CompleteUploadDto {
      return { parts: [{ part_number: 1, etag: 'etag-1' }] };
    }

    it('should throw InvalidVideoStatusException when the video is not in draft and never touch storage', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: 'uploaded' }),
      );

      await expect(
        service.completeUpload('user-1', 'abc123def45', makeCompleteDto()),
      ).rejects.toThrow(InvalidVideoStatusException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should throw UploadExpiredException when the draft was expired by the abandoned-upload sweep', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo({ status: 'error' }));

      await expect(
        service.completeUpload('user-1', 'abc123def45', makeCompleteDto()),
      ).rejects.toThrow(UploadExpiredException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should throw InvalidVideoStatusException when the re-check inside the transaction finds a non-draft status', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo({ status: 'draft' }));
      managerFindOne.mockResolvedValue(makeVideo({ status: 'uploaded' }));

      await expect(
        service.completeUpload('user-1', 'abc123def45', makeCompleteDto()),
      ).rejects.toThrow(InvalidVideoStatusException);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
      expect(queueService.publish).not.toHaveBeenCalled();
    });

    it('should publish the processing job only after the transaction commits', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo({ status: 'draft' }));
      managerFindOne.mockResolvedValue(makeVideo({ status: 'draft' }));

      const result = await service.completeUpload(
        'user-1',
        'abc123def45',
        makeCompleteDto(),
      );

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
        [{ partNumber: 1, etag: 'etag-1' }],
      );
      expect(callOrder).toEqual(['save', 'publish']);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
      expect(queueService.publish).toHaveBeenCalledWith({
        videoId: 'video-1',
        storageKey: 'videos/video-1/original.mp4',
      });
      expect(result.status).toBe('uploaded');
    });
  });

  describe('abortUpload', () => {
    it('should throw InvalidVideoStatusException when the video is not in draft and never touch storage', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: 'uploaded' }),
      );

      await expect(
        service.abortUpload('user-1', 'abc123def45'),
      ).rejects.toThrow(InvalidVideoStatusException);
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
      expect(videoRepository.delete).not.toHaveBeenCalled();
    });

    it('should abort the multipart upload and delete the draft row', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo({ status: 'draft' }));

      await service.abortUpload('user-1', 'abc123def45');

      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
      expect(videoRepository.delete).toHaveBeenCalledWith('video-1');
    });
  });

  describe('getStreamUrl / getDownloadUrl', () => {
    it.each(['draft', 'uploaded', 'processing', 'error'] as const)(
      'should throw VideoNotReadyException for getStreamUrl when status is %s',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(makeVideo({ status }));

        await expect(
          service.getStreamUrl('user-1', 'abc123def45'),
        ).rejects.toThrow(VideoNotReadyException);
        expect(storageService.getSignedDownloadUrl).not.toHaveBeenCalled();
      },
    );

    it.each(['draft', 'uploaded', 'processing', 'error'] as const)(
      'should throw VideoNotReadyException for getDownloadUrl when status is %s',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(makeVideo({ status }));

        await expect(
          service.getDownloadUrl('user-1', 'abc123def45'),
        ).rejects.toThrow(VideoNotReadyException);
        expect(storageService.getSignedDownloadUrl).not.toHaveBeenCalled();
      },
    );

    it('should sign a plain streaming URL with no content-disposition', async () => {
      videoRepository.findOne.mockResolvedValue(makeVideo({ status: 'ready' }));
      storageService.getSignedDownloadUrl.mockResolvedValue(
        'https://signed-stream-url',
      );

      const url = await service.getStreamUrl('user-1', 'abc123def45');

      expect(url).toBe('https://signed-stream-url');
      expect(storageService.getSignedDownloadUrl).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
      );
    });

    it('should sign a download URL with an attachment content-disposition derived from the title', async () => {
      videoRepository.findOne.mockResolvedValue(
        makeVideo({ status: 'ready', title: 'Meu Vídeo Incrível' }),
      );
      storageService.getSignedDownloadUrl.mockResolvedValue(
        'https://signed-download-url',
      );

      const url = await service.getDownloadUrl('user-1', 'abc123def45');

      expect(url).toBe('https://signed-download-url');
      expect(storageService.getSignedDownloadUrl).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        { contentDisposition: 'attachment; filename="Meu-Video-Incrivel.mp4"' },
      );
    });
  });
});
