import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  url: process.env.QUEUE_URL || 'amqp://streamtube:streamtube@rabbitmq:5672',
  exchange: process.env.QUEUE_EXCHANGE || 'video',
  queueName: process.env.QUEUE_NAME || 'video-processing',
  deadLetterExchange: process.env.QUEUE_DEAD_LETTER_EXCHANGE || 'dlx',
  deadLetterQueue:
    process.env.QUEUE_DEAD_LETTER_QUEUE || 'video-processing.dlq',
  maxRetries: parseInt(process.env.QUEUE_MAX_RETRIES || '3', 10),
}));
