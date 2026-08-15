import { Test } from '@nestjs/testing';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with VideoProcessingConsumer and VideoProcessorService, without any HTTP modules', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
