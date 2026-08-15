const DEFAULT_BASENAME = 'video';
const COMBINING_DIACRITICS = /[\u0300-\u036f]/g;

function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(COMBINING_DIACRITICS, '');
}

function extractExtension(storageKey: string): string {
  const lastDot = storageKey.lastIndexOf('.');
  return lastDot === -1 ? '' : storageKey.slice(lastDot);
}

/**
 * Derives an HTTP-header-safe filename from the video title (ASCII only, no
 * quotes/control chars) for use in a Content-Disposition value.
 */
export function deriveDownloadFilename(
  title: string,
  storageKey: string,
): string {
  const extension = extractExtension(storageKey);
  const base = stripDiacritics(title)
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  return `${base || DEFAULT_BASENAME}${extension}`;
}
