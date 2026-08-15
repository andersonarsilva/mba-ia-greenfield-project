import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import databaseConfig from '../../config/database.config';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { envValidationSchema } from '../../config/env.validation';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoProcessorService } from './video-processor.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    QueueModule,
  ],
  providers: [VideoProcessingConsumer, VideoProcessorService],
})
export class WorkerModule {}
