import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VIDEO_STATUS } from './videos.constants';

const UPLOAD_EXPIRED_REASON =
  'Upload expired: not completed within the allowed window';

@Injectable()
export class AbandonedUploadSweepService {
  private readonly logger = new Logger(AbandonedUploadSweepService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, {
    name: 'EXPIRE_ABANDONED_DRAFTS',
    waitForCompletion: true,
  })
  async expireAbandonedDrafts(): Promise<void> {
    const cutoff = new Date(
      Date.now() - this.config.abandonedUploadExpirationHours * 60 * 60 * 1000,
    );

    const abandoned = await this.videoRepository.find({
      where: {
        status: VIDEO_STATUS.DRAFT,
        upload_id: Not(IsNull()),
        created_at: LessThan(cutoff),
      },
    });

    for (const video of abandoned) {
      await this.expireOne(video);
    }
  }

  private async expireOne(video: Video): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(
        video.storage_key as string,
        video.upload_id as string,
      );
    } catch (err) {
      this.logger.error(
        `Failed to abort multipart upload for video ${video.id}: ${(err as Error).message}`,
      );
      return;
    }

    video.status = VIDEO_STATUS.ERROR;
    video.error_reason = UPLOAD_EXPIRED_REASON;
    video.upload_id = null;
    await this.videoRepository.save(video);
  }
}
