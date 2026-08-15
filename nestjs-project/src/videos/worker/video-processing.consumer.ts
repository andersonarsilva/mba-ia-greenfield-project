import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import { QueueService } from '../../queue/queue.service';
import type { VideoProcessPayload } from '../../queue/queue.types';
import { VideoProcessorService } from './video-processor.service';

@Injectable()
export class VideoProcessingConsumer implements OnModuleInit {
  private readonly logger = new Logger(VideoProcessingConsumer.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly videoProcessorService: VideoProcessorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queueService.consume((msg) => {
      void this.handleMessage(msg);
    });
  }

  private async handleMessage(msg: ConsumeMessage): Promise<void> {
    let payload: VideoProcessPayload;
    try {
      payload = JSON.parse(msg.content.toString()) as VideoProcessPayload;
    } catch (err) {
      this.logger.error(
        `Malformed video.process payload, routing to DLX: ${(err as Error).message}`,
      );
      this.queueService.nack(msg);
      return;
    }

    try {
      await this.videoProcessorService.process(payload);
      this.queueService.ack(msg);
    } catch (err) {
      this.logger.error(
        `Processing failed for video ${payload.videoId}: ${(err as Error).message}`,
      );
      this.queueService.nack(msg);
    }
  }
}
