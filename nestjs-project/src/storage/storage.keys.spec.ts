import { getOriginalKey, getThumbnailKey } from './storage.keys';

describe('storage.keys', () => {
  describe('getOriginalKey', () => {
    it('should derive the original key from the video id and extension', () => {
      expect(getOriginalKey('video-1', 'movie.mp4')).toBe(
        'videos/video-1/original.mp4',
      );
    });

    it('should lowercase the extension', () => {
      expect(getOriginalKey('video-1', 'movie.MP4')).toBe(
        'videos/video-1/original.mp4',
      );
    });

    it('should fall back to a default extension when the filename has no extension', () => {
      expect(getOriginalKey('video-1', 'movie')).toBe(
        'videos/video-1/original.bin',
      );
    });

    it('should fall back to a default extension when the extension has unexpected characters', () => {
      expect(getOriginalKey('video-1', 'movie.mp4; rm -rf')).toBe(
        'videos/video-1/original.bin',
      );
    });
  });

  describe('getThumbnailKey', () => {
    it('should derive the thumbnail key from the video id', () => {
      expect(getThumbnailKey('video-1')).toBe('videos/video-1/thumbnail.jpg');
    });
  });
});
