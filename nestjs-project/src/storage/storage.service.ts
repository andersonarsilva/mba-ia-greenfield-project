import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

export interface SignedUploadPart {
  partNumber: number;
  url: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignedUrlExpirationSeconds: number;
  private readonly streamUrlExpirationSeconds: number;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId as string,
        secretAccessKey: this.config.secretAccessKey as string,
      },
    });
    this.bucket = this.config.bucket as string;
    this.presignedUrlExpirationSeconds =
      this.config.presignedUrlExpirationSeconds;
    this.streamUrlExpirationSeconds = this.config.streamUrlExpirationSeconds;
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
    );
    return { uploadId: UploadId as string };
  }

  async signUploadParts(
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<SignedUploadPart[]> {
    const parts: SignedUploadPart[] = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const url = await getSignedUrl(
        this.client,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: this.presignedUrlExpirationSeconds },
      );
      parts.push({ partNumber, url });
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async downloadToFile(key: string, destPath: string): Promise<void> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = result.Body as NodeJS.ReadableStream;
    await pipeline(body, createWriteStream(destPath));
  }

  async uploadFile(
    key: string,
    filePath: string,
    contentType?: string,
  ): Promise<void> {
    const body = await readFile(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(contentType && { ContentType: contentType }),
      }),
    );
  }

  async getSignedDownloadUrl(
    key: string,
    options: { contentDisposition?: string } = {},
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(options.contentDisposition && {
          ResponseContentDisposition: options.contentDisposition,
        }),
      }),
      { expiresIn: this.streamUrlExpirationSeconds },
    );
  }
}
