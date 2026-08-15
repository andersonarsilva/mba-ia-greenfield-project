import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import * as amqp from 'amqplib';
import queueConfig from '../config/queue.config';
import {
  DEAD_LETTER_ROUTING_KEY,
  VIDEO_PROCESS_ROUTING_KEY,
  type VideoProcessPayload,
} from './queue.types';

const RECONNECT_DELAY_MS = 2000;

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private connection: amqp.ChannelModel | null = null;
  private channel: amqp.Channel | null = null;
  private shuttingDown = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    @Inject(queueConfig.KEY)
    private readonly config: ConfigType<typeof queueConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }

  // Not `async`: amqplib's `Channel.publish` is synchronous. The `Promise<void>`
  // return type is part of the public contract (callers await it), so failures
  // are surfaced as a rejected promise rather than a synchronous throw.
  publish(payload: VideoProcessPayload): Promise<void> {
    if (!this.channel) {
      return Promise.reject(new Error('Queue channel is not available'));
    }
    this.channel.publish(
      this.config.exchange,
      VIDEO_PROCESS_ROUTING_KEY,
      Buffer.from(JSON.stringify(payload)),
      { persistent: true },
    );
    return Promise.resolve();
  }

  async consume(onMessage: (msg: amqp.ConsumeMessage) => void): Promise<void> {
    if (!this.channel) {
      throw new Error('Queue channel is not available');
    }
    await this.channel.consume(this.config.queueName, (msg) => {
      if (msg) onMessage(msg);
    });
  }

  ack(msg: amqp.ConsumeMessage): void {
    if (!this.channel) {
      throw new Error('Queue channel is not available');
    }
    this.channel.ack(msg);
  }

  nack(msg: amqp.ConsumeMessage): void {
    if (!this.channel) {
      throw new Error('Queue channel is not available');
    }
    // requeue=false — routes straight to the DLX per phase-03-videos/TD-06.
    this.channel.nack(msg, false, false);
  }

  private async connect(): Promise<void> {
    const connection = await amqp.connect(this.config.url);
    connection.on('error', (err: Error) =>
      this.logger.error(`Connection error: ${err.message}`),
    );
    connection.on('close', () => {
      this.connection = null;
      this.channel = null;
      if (!this.shuttingDown) {
        this.logger.warn(
          'AMQP connection closed unexpectedly, scheduling reconnect',
        );
        this.scheduleReconnect();
      }
    });

    const channel = await connection.createChannel();
    channel.on('error', (err: Error) =>
      this.logger.error(`Channel error: ${err.message}`),
    );

    await this.setupTopology(channel);

    this.connection = connection;
    this.channel = channel;
  }

  private scheduleReconnect(): void {
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err: Error) => {
        this.logger.error(`Reconnect attempt failed: ${err.message}`);
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  private async setupTopology(channel: amqp.Channel): Promise<void> {
    await channel.assertExchange(this.config.deadLetterExchange, 'direct', {
      durable: true,
    });
    await channel.assertQueue(this.config.deadLetterQueue, {
      durable: true,
    });
    await channel.bindQueue(
      this.config.deadLetterQueue,
      this.config.deadLetterExchange,
      DEAD_LETTER_ROUTING_KEY,
    );

    await channel.assertExchange(this.config.exchange, 'direct', {
      durable: true,
    });
    await channel.assertQueue(this.config.queueName, {
      durable: true,
      deadLetterExchange: this.config.deadLetterExchange,
      deadLetterRoutingKey: DEAD_LETTER_ROUTING_KEY,
    });
    await channel.bindQueue(
      this.config.queueName,
      this.config.exchange,
      VIDEO_PROCESS_ROUTING_KEY,
    );
  }
}
