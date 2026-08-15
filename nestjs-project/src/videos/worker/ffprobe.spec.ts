jest.mock('./exec-file-async');

import { execFileAsync } from './exec-file-async';
import { probeVideo } from './ffprobe';

const mockExecFileAsync = execFileAsync as jest.MockedFunction<
  typeof execFileAsync
>;

describe('probeVideo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should parse ffprobe JSON output and map to typed fields', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify({
        format: {
          duration: '12.345',
          size: '204800',
          format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
        },
        streams: [
          { codec_type: 'audio', codec_name: 'aac' },
          { codec_type: 'video', codec_name: 'h264', width: 640, height: 480 },
        ],
      }),
      stderr: '',
    });

    const result = await probeVideo('/tmp/fake.mp4');

    expect(result.durationSeconds).toBe(12);
    expect(result.width).toBe(640);
    expect(result.height).toBe(480);
    expect(result.codec).toBe('h264');
    expect(result.container).toBe('mov,mp4,m4a,3gp,3g2,mj2');
    expect(result.sizeBytes).toBe(204800);
    expect(result.raw.streams).toHaveLength(2);
  });

  it('should throw on non-JSON ffprobe output', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: 'not-json-output',
      stderr: '',
    });

    await expect(probeVideo('/tmp/fake.mp4')).rejects.toThrow('invalid JSON');
  });

  it('should throw when format.duration is missing or invalid', async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify({ format: {}, streams: [] }),
      stderr: '',
    });

    await expect(probeVideo('/tmp/fake.mp4')).rejects.toThrow('duration');
  });

  it('should throw when the ffprobe process itself fails', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('spawn ffprobe ENOENT'));

    await expect(probeVideo('/tmp/fake.mp4')).rejects.toThrow('ffprobe failed');
  });
});
