/**
 * Integration tests for voice.ts
 *
 * These tests exercise the full transcribeVoice pipeline end-to-end using
 * mocked I/O boundaries (fs, child_process, https/http), verifying that all
 * stages (binary detection → download → ffmpeg → whisper → cleanup) work
 * together correctly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before any imports so vi.mock factories can
// reference them via closure.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  // execFileAsync is what voice.ts actually calls (promisify(execFile)).
  // We attach it as util.promisify.custom on execFileMock so that
  // promisify(execFile) returns execFileAsyncMock directly.
  const execFileAsyncMock = vi.fn().mockResolvedValue({ stdout: 'transcribed', stderr: '' });
  const execFileMock = vi.fn();
  (execFileMock as any)[Symbol.for('nodejs.util.promisify.custom')] = execFileAsyncMock;

  return {
    existsSyncMock: vi.fn().mockReturnValue(false),
    createWriteStreamMock: vi.fn(),
    unlinkMock: vi.fn().mockResolvedValue(undefined),
    execFileMock,
    execFileAsyncMock,
    httpsGetMock: vi.fn(),
    httpGetMock: vi.fn(),
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: mocks.existsSyncMock,
    mkdirSync: vi.fn(),
    createWriteStream: mocks.createWriteStreamMock,
  };
});

vi.mock('fs/promises', () => ({
  unlink: mocks.unlinkMock,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: mocks.execFileMock,
  };
});

// voice.ts uses `import https from "https"` (default import)
vi.mock('https', () => ({
  default: { get: mocks.httpsGetMock },
}));

vi.mock('http', () => ({
  default: { get: mocks.httpGetMock },
}));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    tmpdir: () => '/tmp',
  };
});

import { transcribeVoice, isVoiceAvailable } from './voice.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** First candidate paths — used in most "all available" scenarios */
const WHISPER_PATH = '/opt/homebrew/bin/whisper-cli';
const FFMPEG_PATH = '/opt/homebrew/bin/ffmpeg';
const MODEL_PATH = '/opt/homebrew/share/whisper-cpp/ggml-small.en.bin';

function setToolsAvailable(opts: { whisper?: boolean; ffmpeg?: boolean; model?: boolean } = {}) {
  mocks.existsSyncMock.mockImplementation((p: string) => {
    if (opts.whisper && p === WHISPER_PATH) return true;
    if (opts.ffmpeg && p === FFMPEG_PATH) return true;
    if (opts.model && p === MODEL_PATH) return true;
    return false;
  });
}

function setAllToolsAvailable() {
  setToolsAvailable({ whisper: true, ffmpeg: true, model: true });
}

/**
 * Returns a minimal fake WriteStream that stores event handlers and lets the
 * test trigger them via `_emit`.
 */
function makeWriteStream() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const stream = {
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(cb);
      return stream;
    }),
    close: vi.fn((cb: () => void) => cb()),
    _emit(event: string, ...args: unknown[]) {
      (handlers[event] ?? []).forEach((cb) => cb(...args));
    },
  };
  return stream;
}

/**
 * Configures the https mock to simulate a successful (or error) download.
 * The response `pipe` call triggers 'finish' on the write stream via a
 * microtask so that `file.on("finish", ...)` is registered first.
 */
function setupHttpsDownload(statusCode = 200) {
  const fileStream = makeWriteStream();
  mocks.createWriteStreamMock.mockReturnValue(fileStream);

  const mockRequest = { on: vi.fn().mockReturnThis() };
  mocks.httpsGetMock.mockImplementation((_url: string, cb: (res: unknown) => void) => {
    const res = {
      statusCode,
      pipe: vi.fn((dest: ReturnType<typeof makeWriteStream>) => {
        if (statusCode === 200) {
          // Defer so file.on("finish", ...) is registered before we emit
          Promise.resolve().then(() => dest._emit('finish'));
        }
        return dest;
      }),
    };
    cb(res);
    return mockRequest;
  });

  return fileStream;
}

// ---------------------------------------------------------------------------
// isVoiceAvailable
// ---------------------------------------------------------------------------

describe('isVoiceAvailable', () => {
  beforeEach(() => {
    mocks.existsSyncMock.mockReturnValue(false);
  });

  it('returns false when no tools are installed', () => {
    expect(isVoiceAvailable()).toBe(false);
  });

  it('returns false when only whisper is present (missing ffmpeg)', () => {
    setToolsAvailable({ whisper: true });
    expect(isVoiceAvailable()).toBe(false);
  });

  it('returns false when whisper and ffmpeg are present but no model', () => {
    setToolsAvailable({ whisper: true, ffmpeg: true });
    expect(isVoiceAvailable()).toBe(false);
  });

  it('returns true when all three components are available', () => {
    setAllToolsAvailable();
    expect(isVoiceAvailable()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// transcribeVoice
// ---------------------------------------------------------------------------

describe('transcribeVoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.existsSyncMock.mockReturnValue(false);
    mocks.unlinkMock.mockResolvedValue(undefined);
    mocks.execFileAsyncMock.mockResolvedValue({ stdout: 'hello world', stderr: '' });
  });

  // -------------------------------------------------------------------------
  // Binary / model detection errors
  // -------------------------------------------------------------------------

  it('throws when whisper-cpp binary is missing', async () => {
    await expect(transcribeVoice('https://example.com/voice.ogg'))
      .rejects.toThrow('whisper-cpp not found');
  });

  it('throws when ffmpeg is missing', async () => {
    setToolsAvailable({ whisper: true });
    await expect(transcribeVoice('https://example.com/voice.ogg'))
      .rejects.toThrow('ffmpeg not found');
  });

  it('throws when no whisper model file is found', async () => {
    setToolsAvailable({ whisper: true, ffmpeg: true });
    await expect(transcribeVoice('https://example.com/voice.ogg'))
      .rejects.toThrow('No whisper model found');
  });

  // -------------------------------------------------------------------------
  // Full pipeline — all tools available
  // -------------------------------------------------------------------------

  describe('with all tools available', () => {
    beforeEach(() => {
      setAllToolsAvailable();
    });

    it('returns trimmed transcribed text from whisper stdout', async () => {
      mocks.execFileAsyncMock.mockResolvedValue({ stdout: '  hello world  ', stderr: '' });
      setupHttpsDownload();
      expect(await transcribeVoice('https://example.com/voice.ogg')).toBe('hello world');
    });

    it('strips [BLANK_AUDIO] artifacts from whisper output', async () => {
      mocks.execFileAsyncMock.mockResolvedValue({
        stdout: '[BLANK_AUDIO] actual speech [BLANK_AUDIO]',
        stderr: '',
      });
      setupHttpsDownload();
      expect(await transcribeVoice('https://example.com/voice.ogg')).toBe('actual speech');
    });

    it('strips bracket timestamp artifacts from whisper output', async () => {
      mocks.execFileAsyncMock.mockResolvedValue({
        stdout: '[00:00.000 --> 00:03.500] useful speech here',
        stderr: '',
      });
      setupHttpsDownload();
      expect(await transcribeVoice('https://example.com/voice.ogg')).toBe('useful speech here');
    });

    it('returns "[empty transcription]" when output is blank after artifact removal', async () => {
      mocks.execFileAsyncMock.mockResolvedValue({ stdout: '  [BLANK_AUDIO]  ', stderr: '' });
      setupHttpsDownload();
      expect(await transcribeVoice('https://example.com/voice.ogg')).toBe('[empty transcription]');
    });

    it('invokes ffmpeg with 16 kHz mono WAV conversion arguments', async () => {
      setupHttpsDownload();
      await transcribeVoice('https://example.com/voice.ogg');

      const [bin, args] = mocks.execFileAsyncMock.mock.calls[0] as [string, string[]];
      expect(bin).toBe(FFMPEG_PATH);
      expect(args).toContain('-ar');
      expect(args).toContain('16000');
      expect(args).toContain('-ac');
      expect(args).toContain('1');
      expect(args).toContain('-y');
    });

    it('invokes whisper with model path, wav input, and --no-timestamps flag', async () => {
      setupHttpsDownload();
      await transcribeVoice('https://example.com/voice.ogg');

      const [bin, args] = mocks.execFileAsyncMock.mock.calls[1] as [string, string[]];
      expect(bin).toBe(WHISPER_PATH);
      expect(args).toContain('-m');
      expect(args).toContain(MODEL_PATH);
      expect(args).toContain('--no-timestamps');
      expect(args).toContain('-f');
    });

    it('calls ffmpeg before whisper (two sequential execFileAsync calls)', async () => {
      setupHttpsDownload();
      await transcribeVoice('https://example.com/voice.ogg');
      expect(mocks.execFileAsyncMock).toHaveBeenCalledTimes(2);
    });

    // -----------------------------------------------------------------------
    // Temp file cleanup
    // -----------------------------------------------------------------------

    it('deletes ogg and wav temp files after successful transcription', async () => {
      setupHttpsDownload();
      await transcribeVoice('https://example.com/voice.ogg');

      const deleted = mocks.unlinkMock.mock.calls.map(([p]: [string]) => p);
      expect(deleted.some((p: string) => p.endsWith('.ogg'))).toBe(true);
      expect(deleted.some((p: string) => p.endsWith('.wav'))).toBe(true);
    });

    it('still cleans up temp files when ffmpeg throws', async () => {
      mocks.execFileAsyncMock.mockRejectedValue(new Error('ffmpeg conversion failed'));
      setupHttpsDownload();

      await expect(transcribeVoice('https://example.com/voice.ogg'))
        .rejects.toThrow('ffmpeg conversion failed');

      const deleted = mocks.unlinkMock.mock.calls.map(([p]: [string]) => p);
      expect(deleted.some((p: string) => p.endsWith('.ogg'))).toBe(true);
    });

    it('still cleans up temp files when whisper throws', async () => {
      mocks.execFileAsyncMock
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // ffmpeg succeeds
        .mockRejectedValueOnce(new Error('whisper error'));  // whisper fails
      setupHttpsDownload();

      await expect(transcribeVoice('https://example.com/voice.ogg'))
        .rejects.toThrow('whisper error');

      const deleted = mocks.unlinkMock.mock.calls.map(([p]: [string]) => p);
      expect(deleted.some((p: string) => p.endsWith('.ogg'))).toBe(true);
      expect(deleted.some((p: string) => p.endsWith('.wav'))).toBe(true);
    });

    // -----------------------------------------------------------------------
    // Download errors
    // -----------------------------------------------------------------------

    it('throws when the download returns a non-200 HTTP status', async () => {
      setupHttpsDownload(404);
      await expect(transcribeVoice('https://example.com/missing.ogg'))
        .rejects.toThrow('HTTP 404');
    });

    it('uses the provided HTTPS URL to download the voice file', async () => {
      setupHttpsDownload();
      await transcribeVoice('https://example.com/voice.ogg');
      expect(mocks.httpsGetMock).toHaveBeenCalledWith(
        'https://example.com/voice.ogg',
        expect.any(Function),
      );
    });
  });
});
