import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
  bucket: process.env.STORAGE_BUCKET,
  forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE || 'true') === 'true',
  presignedUrlExpirationSeconds: parseInt(
    process.env.STORAGE_PRESIGNED_URL_EXPIRATION_SECONDS || '3600',
    10,
  ),
  streamUrlExpirationSeconds: parseInt(
    process.env.STORAGE_STREAM_URL_EXPIRATION_SECONDS || '300',
    10,
  ),
}));
