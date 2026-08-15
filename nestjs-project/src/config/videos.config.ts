import { registerAs } from '@nestjs/config';

export default registerAs('videos', () => ({
  abandonedUploadExpirationHours: parseInt(
    process.env.ABANDONED_UPLOAD_EXPIRATION_HOURS || '24',
    10,
  ),
}));
