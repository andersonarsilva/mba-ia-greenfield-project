import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  GetObjectCommand,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { getOriginalKey } from './storage.keys';
import { StorageService } from './storage.service';

describe('StorageService (integration)', () => {
  let service: StorageService;
  let rawClient: S3Client;
  let bucket: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      ],
      providers: [StorageService],
    }).compile();

    service = module.get(StorageService);
    bucket = process.env.STORAGE_BUCKET as string;
    rawClient = new S3Client({
      endpoint: process.env.STORAGE_ENDPOINT,
      region: process.env.STORAGE_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY as string,
      },
    });
  });

  async function uploadSinglePartObject(
    videoId: string,
    content: Buffer,
  ): Promise<string> {
    const key = getOriginalKey(videoId, 'video.mp4');
    const { uploadId } = await service.createMultipartUpload(key);
    const [part] = await service.signUploadParts(key, uploadId, 1);

    const putResponse = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(content),
    });
    const etag = putResponse.headers.get('etag') as string;

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag },
    ]);

    return key;
  }

  it('should keep the object intact in the bucket after completing the multipart upload', async () => {
    const content = Buffer.from('the quick brown fox jumps over the lazy dog');

    const key = await uploadSinglePartObject('storage-complete-1', content);

    const result = await rawClient.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = await result.Body?.transformToByteArray();

    expect(Buffer.from(body as Uint8Array)).toEqual(content);
    expect(result.ContentLength).toBe(content.length);
  });

  it('should remove the parts when aborting a multipart upload', async () => {
    const key = getOriginalKey('storage-abort-1', 'video.mp4');
    const { uploadId } = await service.createMultipartUpload(key);
    const [part] = await service.signUploadParts(key, uploadId, 1);
    await fetch(part.url, { method: 'PUT', body: Buffer.from('partial') });

    await service.abortMultipartUpload(key, uploadId);

    await expect(
      rawClient.send(
        new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      ),
    ).rejects.toThrow();
  });

  it('should serve a Range request as 206 Partial Content via the signed download URL', async () => {
    const content = Buffer.from('0123456789'.repeat(100));

    const key = await uploadSinglePartObject('storage-range-1', content);
    const url = await service.getSignedDownloadUrl(key);

    const rangeResponse = await fetch(url, {
      headers: { Range: 'bytes=0-9' },
    });
    const rangeBody = await rangeResponse.text();

    expect(rangeResponse.status).toBe(206);
    expect(rangeBody).toBe(content.subarray(0, 10).toString());
  });
});
