/**
 * Voice message transcription via whisper.cpp.
 * Flow: Telegram OGG → ffmpeg convert to 16kHz WAV → whisper-cpp → text
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync } from "fs";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import https from "https";
import http from "http";
import { createWriteStream } from "fs";

const execFileAsync = promisify(execFile);

// Whisper model — small.en is fast and accurate enough for commands
// Falls back to base.en if small not found
const WHISPER_MODELS = [
  "/opt/homebrew/share/whisper-cpp/ggml-small.en.bin",
  "/opt/homebrew/share/whisper-cpp/ggml-small.bin",
  "/opt/homebrew/share/whisper-cpp/ggml-base.en.bin",
  "/opt/homebrew/share/whisper-cpp/ggml-base.bin",
  // user-local
  `${process.env.HOME}/.local/share/whisper-cpp/ggml-small.en.bin`,
  `${process.env.HOME}/.local/share/whisper-cpp/ggml-base.en.bin`,
];

const WHISPER_BIN_CANDIDATES = [
  "/opt/homebrew/bin/whisper-cli",   // whisper-cpp brew formula installs as whisper-cli
  "/opt/homebrew/bin/whisper-cpp",
  "/usr/local/bin/whisper-cli",
  "/usr/local/bin/whisper-cpp",
  "/opt/homebrew/bin/whisper",
];

const FFMPEG_CANDIDATES = [
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/usr/bin/ffmpeg",
];

function findBin(candidates: string[]): string | null {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function findModel(): string | null {
  for (const p of WHISPER_MODELS) {
    if (existsSync(p)) return p;
  }
  return null;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const getter = url.startsWith("https") ? https : http;
    getter.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

/**
 * Transcribe a voice message from a Telegram file URL.
 * Returns the transcribed text, or throws if whisper/ffmpeg not available.
 */
export async function transcribeVoice(fileUrl: string): Promise<string> {
  const whisperBin = findBin(WHISPER_BIN_CANDIDATES);
  if (!whisperBin) throw new Error("whisper-cpp not found — install with: brew install whisper-cpp");

  const ffmpegBin = findBin(FFMPEG_CANDIDATES);
  if (!ffmpegBin) throw new Error("ffmpeg not found — install with: brew install ffmpeg");

  const model = findModel();
  if (!model) throw new Error("No whisper model found — run: whisper-cpp-download-ggml-model small.en");

  const tmp = join(tmpdir(), `cc-tg-voice-${Date.now()}`);
  const oggPath = `${tmp}.ogg`;
  const wavPath = `${tmp}.wav`;

  try {
    // 1. Download OGG from Telegram
    await downloadFile(fileUrl, oggPath);

    // 2. Convert OGG → 16kHz mono WAV (whisper requirement)
    await execFileAsync(ffmpegBin, [
      "-y", "-i", oggPath,
      "-ar", "16000",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      wavPath,
    ]);

    // 3. Run whisper-cpp
    const { stdout } = await execFileAsync(whisperBin, [
      "-m", model,
      "-f", wavPath,
      "--no-timestamps",
      "-l", "auto",
      "--output-txt",
    ]);

    // whisper outputs to stdout — strip leading/trailing whitespace and [BLANK_AUDIO] artifacts
    const text = stdout
      .replace(/\[BLANK_AUDIO\]/gi, "")
      .replace(/\[.*?\]/g, "")  // remove timestamp artifacts
      .trim();

    return text || "[empty transcription]";
  } finally {
    // Cleanup temp files
    await unlink(oggPath).catch(() => {});
    await unlink(wavPath).catch(() => {});
    await unlink(`${wavPath}.txt`).catch(() => {});
  }
}

/**
 * Check if voice transcription is available on this system.
 */
export function isVoiceAvailable(): boolean {
  return (
    findBin(WHISPER_BIN_CANDIDATES) !== null &&
    findBin(FFMPEG_CANDIDATES) !== null &&
    findModel() !== null
  );
}
