import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video } from './entities/video.entity';
import { InitiateUploadResult, VideosService } from './videos.service';

interface VideoResponse {
  id: string;
  public_id: string;
  title: string;
  status: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  container: string | null;
  size_bytes: number | null;
  error_reason: string | null;
  created_at: string;
}

function toVideoResponse(video: Video): VideoResponse {
  return {
    id: video.id,
    public_id: video.public_id,
    title: video.title,
    status: video.status,
    duration_seconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    codec: video.codec,
    container: video.container,
    size_bytes: video.size_bytes === null ? null : Number(video.size_bytes),
    error_reason: video.error_reason,
    created_at: video.created_at.toISOString(),
  };
}

@ApiTags('videos')
@ApiBearerAuth()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post('uploads')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers the video as a draft and opens a multipart upload, returning presigned URLs for each part.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        upload_id: { type: 'string' },
        part_size_bytes: { type: 'integer' },
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 413,
    description: 'File exceeds the 10GB limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 415,
    description: 'Unsupported content type',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Get(':publicId')
  @ApiOperation({
    summary: 'Get a video',
    description:
      "Returns the video's processing state and metadata, restricted to the owning channel.",
  })
  @ApiResponse({ status: 200, description: 'Video found' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findOne(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<VideoResponse> {
    const video = await this.videosService.findByPublicIdForOwner(
      user.sub,
      publicId,
    );
    return toVideoResponse(video);
  }

  @Post(':publicId/uploads/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload in storage and publishes the processing job.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        public_id: { type: 'string' },
        status: { type: 'string', example: 'uploaded' },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<{ id: string; public_id: string; status: string }> {
    const video = await this.videosService.completeUpload(
      user.sub,
      publicId,
      dto,
    );
    return { id: video.id, public_id: video.public_id, status: video.status };
  }

  @Delete(':publicId/uploads')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Abort a video upload',
    description:
      'Cancels an in-progress upload — aborts the multipart in storage and removes the draft row.',
  })
  @ApiResponse({ status: 204, description: 'Upload aborted' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not in draft status',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async abortUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    await this.videosService.abortUpload(user.sub, publicId);
  }

  @Get(':publicId/stream')
  @Redirect()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a short-lived presigned URL; the storage serves the object directly, including Range/206 support.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned streaming URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getStreamUrl(user.sub, publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }

  @Get(':publicId/download')
  @Redirect()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a short-lived presigned URL that forces Content-Disposition: attachment.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned download URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<{ url: string; statusCode: number }> {
    const url = await this.videosService.getDownloadUrl(user.sub, publicId);
    return { url, statusCode: HttpStatus.FOUND };
  }
}
