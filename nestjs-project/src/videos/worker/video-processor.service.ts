import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { VideoProcessPayload } from '../../queue/queue.types';
import { getThumbnailKey } from '../../storage/storage.keys';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { VIDEO_STATUS } from '../videos.constants';
import { probeVideo } from './ffprobe';
import { extractThumbnail } from './thumbnail';

@Injectable()
export class VideoProcessorService {
  private readonly logger = new Logger(VideoProcessorService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async process(payload: VideoProcessPayload): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: payload.videoId },
    });
    if (!video) {
      this.logger.warn(`Video ${payload.videoId} not found, skipping`);
      return;
    }

    if (
      video.status !== VIDEO_STATUS.UPLOADED &&
      video.status !== VIDEO_STATUS.PROCESSING
    ) {
      this.logger.log(
        `Video ${payload.videoId} is already ${video.status}, skipping redelivery`,
      );
      return;
    }

    video.status = VIDEO_STATUS.PROCESSING;
    await this.videoRepository.save(video);

    const workDir = await mkdtemp(join(tmpdir(), `video-${randomUUID()}-`));
    const videoPath = join(workDir, 'original');
    const thumbnailPath = join(workDir, 'thumbnail.jpg');

    try {
      await this.storageService.downloadToFile(payload.storageKey, videoPath);

      const metadata = await probeVideo(videoPath);
      await extractThumbnail(videoPath, thumbnailPath);

      const thumbnailKey = getThumbnailKey(payload.videoId);
      await this.storageService.uploadFile(
        thumbnailKey,
        thumbnailPath,
        'image/jpeg',
      );

      video.status = VIDEO_STATUS.READY;
      video.duration_seconds = metadata.durationSeconds;
      video.width = metadata.width;
      video.height = metadata.height;
      video.codec = metadata.codec;
      video.container = metadata.container;
      video.size_bytes = String(metadata.sizeBytes);
      video.metadata = metadata.raw;
      video.thumbnail_key = thumbnailKey;
      video.error_reason = null;
      await this.videoRepository.save(video);
    } catch (err) {
      video.status = VIDEO_STATUS.ERROR;
      video.error_reason = (err as Error).message;
      await this.videoRepository.save(video);
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
