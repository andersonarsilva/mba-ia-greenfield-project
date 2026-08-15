import { execFileAsync } from './exec-file-async';

const FFMPEG_TIMEOUT_MS = 30000;
const DEFAULT_FRAME_AT_SECONDS = 1;

export async function extractThumbnail(
  videoPath: string,
  outputPath: string,
  atSeconds = DEFAULT_FRAME_AT_SECONDS,
): Promise<void> {
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-ss',
        String(atSeconds),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '2',
        outputPath,
      ],
      { timeout: FFMPEG_TIMEOUT_MS },
    );
  } catch (err) {
    throw new Error(
      `ffmpeg thumbnail extraction failed: ${(err as Error).message}`,
    );
  }
}
