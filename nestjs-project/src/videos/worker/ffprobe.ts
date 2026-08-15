import { execFileAsync } from './exec-file-async';

const FFPROBE_TIMEOUT_MS = 30000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface FfprobeOutput {
  format?: {
    duration?: string;
    size?: string;
    format_name?: string;
    [key: string]: unknown;
  };
  streams?: FfprobeStream[];
  [key: string]: unknown;
}

export interface VideoMetadata {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  codec: string | null;
  container: string | null;
  sizeBytes: number;
  raw: FfprobeOutput;
}

export async function probeVideo(filePath: string): Promise<VideoMetadata> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { timeout: FFPROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
    );
    stdout = result.stdout;
  } catch (err) {
    throw new Error(`ffprobe failed: ${(err as Error).message}`);
  }

  let raw: FfprobeOutput;
  try {
    raw = JSON.parse(stdout) as FfprobeOutput;
  } catch (err) {
    throw new Error(
      `ffprobe produced invalid JSON output: ${(err as Error).message}`,
    );
  }

  const durationRaw = raw.format?.duration;
  const duration = durationRaw !== undefined ? Number(durationRaw) : NaN;
  if (!Number.isFinite(duration)) {
    throw new Error('ffprobe output is missing a valid format.duration');
  }

  const videoStream = raw.streams?.find(
    (stream) => stream.codec_type === 'video',
  );
  const sizeRaw = raw.format?.size;
  const size = sizeRaw !== undefined ? Number(sizeRaw) : NaN;

  return {
    durationSeconds: Math.round(duration),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    codec: videoStream?.codec_name ?? null,
    container: raw.format?.format_name ?? null,
    sizeBytes: Number.isFinite(size) ? size : 0,
    raw,
  };
}
