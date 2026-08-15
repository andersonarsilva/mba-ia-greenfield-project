import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY_ID: 'streamtube',
  STORAGE_SECRET_ACCESS_KEY: 'streamtube',
  STORAGE_BUCKET: 'streamtube-videos',
  QUEUE_URL: 'amqp://streamtube:streamtube@rabbitmq:5672',
};

interface ValidatedEnv {
  error?: ValidationError;
  value: Record<string, unknown>;
}

const validate = (env: Record<string, string>): ValidatedEnv =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as ValidatedEnv;

describe('envValidationSchema — storage and queue keys', () => {
  it('should accept the full required set with no errors', () => {
    const { error } = validate({});
    expect(error).toBeUndefined();
  });

  it.each([
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
    'STORAGE_BUCKET',
    'QUEUE_URL',
  ])('should reject a payload missing required key %s', (key) => {
    const env = { ...requiredEnv };
    delete (env as Record<string, string>)[key];
    const { error } = envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject a QUEUE_URL that is not a valid amqp(s) URI', () => {
    const { error } = validate({ QUEUE_URL: 'http://rabbitmq:5672' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_URL');
  });

  it('should reject a STORAGE_ENDPOINT that is not a valid URI', () => {
    const { error } = validate({ STORAGE_ENDPOINT: 'not-a-url' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('should reject STORAGE_FORCE_PATH_STYLE with a value outside true/false', () => {
    const { error } = validate({ STORAGE_FORCE_PATH_STYLE: 'yes' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('STORAGE_FORCE_PATH_STYLE');
  });

  it('should apply the documented defaults when optional storage/queue keys are absent', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_FORCE_PATH_STYLE).toBe('true');
    expect(value.STORAGE_PRESIGNED_URL_EXPIRATION_SECONDS).toBe(3600);
    expect(value.QUEUE_EXCHANGE).toBe('video');
    expect(value.QUEUE_NAME).toBe('video-processing');
    expect(value.QUEUE_DEAD_LETTER_EXCHANGE).toBe('dlx');
    expect(value.QUEUE_DEAD_LETTER_QUEUE).toBe('video-processing.dlq');
    expect(value.QUEUE_MAX_RETRIES).toBe(3);
    expect(value.ABANDONED_UPLOAD_EXPIRATION_HOURS).toBe(24);
  });
});
