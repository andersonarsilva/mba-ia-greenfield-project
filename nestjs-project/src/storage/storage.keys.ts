const SAFE_EXTENSION = /^[a-z0-9]+$/i;
const DEFAULT_EXTENSION = 'bin';

function extractExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filename.length - 1) {
    return DEFAULT_EXTENSION;
  }
  const ext = filename.slice(lastDot + 1).toLowerCase();
  return SAFE_EXTENSION.test(ext) ? ext : DEFAULT_EXTENSION;
}

export function getOriginalKey(videoId: string, filename: string): string {
  return `videos/${videoId}/original.${extractExtension(filename)}`;
}

export function getThumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
