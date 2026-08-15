import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import * as amqp from 'amqplib';
import queueConfig from '../config/queue.config';
import { QueueService } from './queue.service';
import type { VideoProcessPayload } from './queue.types';

interface QueueInfo {
  name: string;
  messages: number;
  arguments: Record<string, unknown>;
}

interface ConnectionInfo {
  name: string;
}

interface ManagementMessage {
  payload: string;
  properties: { headers: Record<string, unknown> };
}

const MANAGEMENT_URL = 'http://rabbitmq:15672';
const MANAGEMENT_AUTH =
  'Basic ' + Buffer.from('streamtube:streamtube').toString('base64');

async function managementApi<T>(path: string): Promise<T> {
  const res = await fetch(`${MANAGEMENT_URL}${path}`, {
    headers: { Authorization: MANAGEMENT_AUTH },
  });
  if (!res.ok) {
    throw new Error(`Management API ${path} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10000,
  intervalMs = 300,
): Promise<T> {
  const start = Date.now();
  let last: T | undefined;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`pollUntil timed out. Last value: ${JSON.stringify(last)}`);
}

async function retryUntilSuccess<T>(
  fn: () => Promise<T>,
  timeoutMs = 15000,
  intervalMs = 300,
): Promise<T> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw lastError;
}

describe('QueueService (integration)', () => {
  let module: TestingModule;
  let service: QueueService;
  const queueName = process.env.QUEUE_NAME as string;
  const dlq = process.env.QUEUE_DEAD_LETTER_QUEUE as string;
  const deadLetterExchange = process.env.QUEUE_DEAD_LETTER_EXCHANGE as string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] })],
      providers: [QueueService],
    }).compile();

    service = module.get(QueueService);
    await service.onModuleInit();
  }, 30000);

  afterAll(async () => {
    await service.onModuleDestroy();
    await module.close();
  });

  it('should declare the work queue and the DLQ with dead-lettering configured after boot', async () => {
    const queueInfo = await managementApi<QueueInfo>(
      `/api/queues/%2f/${encodeURIComponent(queueName)}`,
    );
    expect(queueInfo.arguments['x-dead-letter-exchange']).toBe(
      deadLetterExchange,
    );
    expect(queueInfo.arguments['x-dead-letter-routing-key']).toBe('dead');

    const dlqInfo = await managementApi<QueueInfo>(
      `/api/queues/%2f/${encodeURIComponent(dlq)}`,
    );
    expect(dlqInfo.name).toBe(dlq);
  });

  it('should deliver a published message to a consumer on the work queue', async () => {
    const conn = await amqp.connect(process.env.QUEUE_URL as string);
    const channel = await conn.createChannel();

    const received: unknown[] = [];
    await channel.consume(queueName, (msg) => {
      if (!msg) return;
      received.push(JSON.parse(msg.content.toString()));
      channel.ack(msg);
    });

    await service.publish({ videoId: 'roundtrip-video', storageKey: 'k' });

    await pollUntil(
      () => Promise.resolve(received.length),
      (count) => count > 0,
    );

    expect(received[0]).toEqual({
      videoId: 'roundtrip-video',
      storageKey: 'k',
    });

    await channel.close();
    await conn.close();
  }, 15000);

  it('should route a nacked message to the DLQ carrying x-death history', async () => {
    const conn = await amqp.connect(process.env.QUEUE_URL as string);
    const channel = await conn.createChannel();

    let messageToReject: amqp.ConsumeMessage | null = null;
    await channel.consume(queueName, (msg) => {
      if (!msg) return;
      const payload = JSON.parse(msg.content.toString()) as VideoProcessPayload;
      if (payload.videoId === 'reject-video') {
        messageToReject = msg;
      } else {
        channel.ack(msg);
      }
    });

    await service.publish({ videoId: 'reject-video', storageKey: 'k' });

    await pollUntil(
      () => Promise.resolve(messageToReject),
      (msg) => msg !== null,
    );
    channel.nack(
      messageToReject as unknown as amqp.ConsumeMessage,
      false,
      false,
    );

    const dlqMessage = await pollUntil(
      () =>
        managementApi<QueueInfo>(`/api/queues/%2f/${encodeURIComponent(dlq)}`),
      (info) => info.messages > 0,
    );
    expect(dlqMessage.messages).toBeGreaterThan(0);

    const getResult = await fetch(
      `${MANAGEMENT_URL}/api/queues/%2f/${encodeURIComponent(dlq)}/get`,
      {
        method: 'POST',
        headers: {
          Authorization: MANAGEMENT_AUTH,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          count: 5,
          ackmode: 'ack_requeue_false',
          encoding: 'auto',
        }),
      },
    );
    const messages = (await getResult.json()) as ManagementMessage[];
    const rejected = messages.find(
      (m) =>
        (JSON.parse(m.payload) as VideoProcessPayload).videoId ===
        'reject-video',
    );
    expect(rejected).toBeDefined();
    const xDeath = rejected!.properties.headers['x-death'] as unknown[];
    expect(xDeath).toBeDefined();
    expect(xDeath.length).toBeGreaterThan(0);

    await channel.close();
    await conn.close();
  }, 15000);

  it('should recover publish capability after the broker connection is force-closed', async () => {
    const connsBefore =
      await managementApi<ConnectionInfo[]>('/api/connections');
    for (const conn of connsBefore) {
      await fetch(
        `${MANAGEMENT_URL}/api/connections/${encodeURIComponent(conn.name)}`,
        { method: 'DELETE', headers: { Authorization: MANAGEMENT_AUTH } },
      );
    }

    await retryUntilSuccess(() =>
      service.publish({ videoId: 'reconnect-video', storageKey: 'k' }),
    );

    const conn = await amqp.connect(process.env.QUEUE_URL as string);
    const channel = await conn.createChannel();
    let received: unknown = null;
    await channel.consume(queueName, (msg) => {
      if (!msg) return;
      const payload = JSON.parse(msg.content.toString()) as VideoProcessPayload;
      if (payload.videoId === 'reconnect-video') {
        received = payload;
      }
      channel.ack(msg);
    });

    await pollUntil(
      () => Promise.resolve(received),
      (value) => value !== null,
    );
    expect(received).toEqual({
      videoId: 'reconnect-video',
      storageKey: 'k',
    });

    await channel.close();
    await conn.close();
  }, 30000);
});
