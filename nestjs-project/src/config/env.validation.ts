import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  STORAGE_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_ACCESS_KEY_ID: Joi.string().required(),
  STORAGE_SECRET_ACCESS_KEY: Joi.string().required(),
  STORAGE_BUCKET: Joi.string().required(),
  STORAGE_FORCE_PATH_STYLE: Joi.string().valid('true', 'false').default('true'),
  STORAGE_PRESIGNED_URL_EXPIRATION_SECONDS: Joi.number().default(3600),
  STORAGE_STREAM_URL_EXPIRATION_SECONDS: Joi.number().default(300),
  QUEUE_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),
  QUEUE_EXCHANGE: Joi.string().default('video'),
  QUEUE_NAME: Joi.string().default('video-processing'),
  QUEUE_DEAD_LETTER_EXCHANGE: Joi.string().default('dlx'),
  QUEUE_DEAD_LETTER_QUEUE: Joi.string().default('video-processing.dlq'),
  QUEUE_MAX_RETRIES: Joi.number().default(3),
  ABANDONED_UPLOAD_EXPIRATION_HOURS: Joi.number().default(24),
});
