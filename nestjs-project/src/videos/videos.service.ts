import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import {
  FileTooLargeException,
  InvalidVideoStatusException,
  UnsupportedMediaTypeException,
  UploadExpiredException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { QueueService } from '../queue/queue.service';
import { SignedUploadPart, StorageService } from '../storage/storage.service';
import { getOriginalKey } from '../storage/storage.keys';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { deriveDownloadFilename } from './download-filename';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.generator';
import {
  MAX_FILE_SIZE_BYTES,
  PUBLIC_ID_MAX_RETRIES,
  SUPPORTED_VIDEO_CONTENT_TYPES,
  UPLOAD_PART_SIZE_BYTES,
  VIDEO_STATUS,
} from './videos.constants';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

function isPublicIdUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as unknown as { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(PUBLIC_ID_COLUMN)
  );
}

export interface InitiateUploadResult {
  id: string;
  public_id: string;
  status: string;
  upload_id: string;
  part_size_bytes: number;
  parts: SignedUploadPart[];
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly queueService: QueueService,
    private readonly dataSource: DataSource,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    if (dto.size_bytes > MAX_FILE_SIZE_BYTES) {
      throw new FileTooLargeException();
    }
    if (!SUPPORTED_VIDEO_CONTENT_TYPES.has(dto.content_type)) {
      throw new UnsupportedMediaTypeException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const id = randomUUID();
    const storageKey = getOriginalKey(id, dto.filename);
    const { uploadId } =
      await this.storageService.createMultipartUpload(storageKey);

    const partCount = Math.ceil(dto.size_bytes / UPLOAD_PART_SIZE_BYTES);
    const parts = await this.storageService.signUploadParts(
      storageKey,
      uploadId,
      partCount,
    );

    const video = await this.insertDraftWithRetry({
      id,
      channelId: channel.id,
      title: dto.title,
      storageKey,
      uploadId,
    });

    return {
      id: video.id,
      public_id: video.public_id,
      status: video.status,
      upload_id: uploadId,
      part_size_bytes: UPLOAD_PART_SIZE_BYTES,
      parts,
    };
  }

  async findByPublicIdForOwner(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  async completeUpload(
    userId: string,
    publicId: string,
    dto: CompleteUploadDto,
  ): Promise<Video> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status === VIDEO_STATUS.ERROR) {
      // A draft can only reach `error` via the abandoned-upload sweep — any
      // other status transition leaves `draft` for `uploaded`, never `error`.
      throw new UploadExpiredException();
    }
    if (video.status !== VIDEO_STATUS.DRAFT) {
      throw new InvalidVideoStatusException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key as string,
      video.upload_id as string,
      dto.parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      })),
    );

    const updated = await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(Video, {
        where: { id: video.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked || locked.status !== VIDEO_STATUS.DRAFT) {
        throw new InvalidVideoStatusException();
      }
      locked.status = VIDEO_STATUS.UPLOADED;
      locked.upload_id = null;
      return manager.save(locked);
    });

    await this.queueService.publish({
      videoId: updated.id,
      storageKey: updated.storage_key as string,
    });

    return updated;
  }

  async abortUpload(userId: string, publicId: string): Promise<void> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new VideoNotFoundException();
    }

    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel_id: channel.id },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VIDEO_STATUS.DRAFT) {
      throw new InvalidVideoStatusException();
    }

    await this.storageService.abortMultipartUpload(
      video.storage_key as string,
      video.upload_id as string,
    );
    await this.videoRepository.delete(video.id);
  }

  async getStreamUrl(userId: string, publicId: string): Promise<string> {
    const video = await this.resolveReadyVideoForOwner(userId, publicId);
    return this.storageService.getSignedDownloadUrl(
      video.storage_key as string,
    );
  }

  async getDownloadUrl(userId: string, publicId: string): Promise<string> {
    const video = await this.resolveReadyVideoForOwner(userId, publicId);
    const filename = deriveDownloadFilename(
      video.title,
      video.storage_key as string,
    );
    return this.storageService.getSignedDownloadUrl(
      video.storage_key as string,
      { contentDisposition: `attachment; filename="${filename}"` },
    );
  }

  private async resolveReadyVideoForOwner(
    userId: string,
    publicId: string,
  ): Promise<Video> {
    const video = await this.findByPublicIdForOwner(userId, publicId);
    if (video.status !== VIDEO_STATUS.READY) {
      throw new VideoNotReadyException();
    }
    return video;
  }

  private async insertDraftWithRetry(input: {
    id: string;
    channelId: string;
    title: string;
    storageKey: string;
    uploadId: string;
  }): Promise<Video> {
    for (let attempt = 0; attempt <= PUBLIC_ID_MAX_RETRIES; attempt++) {
      const video = this.videoRepository.create({
        id: input.id,
        public_id: generatePublicId(),
        channel_id: input.channelId,
        title: input.title,
        storage_key: input.storageKey,
        upload_id: input.uploadId,
      });

      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        if (!isPublicIdUniqueViolation(err)) {
          throw err;
        }
        // Collision on the generated public_id — astronomically unlikely, retry with a fresh id.
      }
    }

    throw new Error(
      'public_id conflict could not be resolved after max retries',
    );
  }
}
