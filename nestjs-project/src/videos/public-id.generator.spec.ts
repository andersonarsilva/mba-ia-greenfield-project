import { generatePublicId } from './public-id.generator';

const URL_SAFE_PATTERN = /^[0-9A-Za-z_-]+$/;

describe('generatePublicId', () => {
  it('should generate an id with exactly 11 characters', () => {
    expect(generatePublicId()).toHaveLength(11);
  });

  it('should use only URL-safe characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePublicId()).toMatch(URL_SAFE_PATTERN);
    }
  });

  it('should not collide across a batch of 10,000 generated ids', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      ids.add(generatePublicId());
    }
    expect(ids.size).toBe(10_000);
  });
});
