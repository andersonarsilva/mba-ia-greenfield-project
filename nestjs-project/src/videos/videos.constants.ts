export const VIDEO_STATUS = {
  DRAFT: 'draft',
  UPLOADED: 'uploaded',
  PROCESSING: 'processing',
  READY: 'ready',
  ERROR: 'error',
} as const;

export type VideoStatus = (typeof VIDEO_STATUS)[keyof typeof VIDEO_STATUS];

export const PUBLIC_ID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
export const PUBLIC_ID_LENGTH = 11;
export const PUBLIC_ID_MAX_RETRIES = 5;

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10GB

export const SUPPORTED_VIDEO_CONTENT_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
  'video/mpeg',
]);

export const UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024; // 8MB — keeps part count well under the S3 10,000-part limit for 10GB uploads
