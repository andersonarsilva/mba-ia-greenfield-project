import { Test } from '@nestjs/testing';
import type { ConsumeMessage } from 'amqplib';
import { QueueService } from '../../queue/queue.service';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessorService } from './video-processor.service';

function makeMessage(content: unknown): ConsumeMessage {
  return { content: Buffer.from(JSON.stringify(content)) } as ConsumeMessage;
}

/** `handleMessage` is private; call it through a structural cast so `this` stays bound. */
function invokeHandleMessage(
  consumer: VideoProcessingConsumer,
  msg: ConsumeMessage,
): Promise<void> {
  return (
    consumer as unknown as {
      handleMessage(msg: ConsumeMessage): Promise<void>;
    }
  ).handleMessage(msg);
}

describe('VideoProcessingConsumer', () => {
  let consumer: VideoProcessingConsumer;
  let queueService: jest.Mocked<QueueService>;
  let videoProcessorService: jest.Mocked<VideoProcessorService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingConsumer,
        {
          provide: QueueService,
          useValue: { consume: jest.fn(), ack: jest.fn(), nack: jest.fn() },
        },
        {
          provide: VideoProcessorService,
          useValue: { process: jest.fn() },
        },
      ],
    }).compile();

    consumer = module.get(VideoProcessingConsumer);
    queueService = module.get(QueueService);
    videoProcessorService = module.get(VideoProcessorService);
  });

  it('should ack the message when processing succeeds', async () => {
    videoProcessorService.process.mockResolvedValue(undefined);
    const msg = makeMessage({
      videoId: 'v1',
      storageKey: 'videos/v1/original.mp4',
    });

    await invokeHandleMessage(consumer, msg);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(videoProcessorService.process).toHaveBeenCalledWith({
      videoId: 'v1',
      storageKey: 'videos/v1/original.mp4',
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(queueService.ack).toHaveBeenCalledWith(msg);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(queueService.nack).not.toHaveBeenCalled();
  });

  it('should nack without requeue when processing fails', async () => {
    videoProcessorService.process.mockRejectedValue(new Error('boom'));
    const msg = makeMessage({ videoId: 'v1', storageKey: 'k' });

    await invokeHandleMessage(consumer, msg);

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(queueService.nack).toHaveBeenCalledWith(msg);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(queueService.ack).not.toHaveBeenCalled();
  });

  it('should nack a malformed payload without crashing the consumer', async () => {
    const msg = { content: Buffer.from('not-json') } as ConsumeMessage;

    await expect(invokeHandleMessage(consumer, msg)).resolves.toBeUndefined();

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(queueService.nack).toHaveBeenCalledWith(msg);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock reference, not an unbound `this` call
    expect(videoProcessorService.process).not.toHaveBeenCalled();
  });
});
