import { describe, it, expect } from 'vitest';
import { extractText } from './claude.js';

describe('extractText', () => {
  it('extracts text from result-type message', () => {
    const msg = {
      type: 'result' as const,
      payload: { result: 'Hello from Claude' },
      raw: {},
    };
    expect(extractText(msg)).toBe('Hello from Claude');
  });

  it('returns empty string for result with no result field', () => {
    const msg = {
      type: 'result' as const,
      payload: {},
      raw: {},
    };
    expect(extractText(msg)).toBe('');
  });

  it('extracts string content from assistant message', () => {
    const msg = {
      type: 'assistant' as const,
      payload: { message: { content: 'Direct string' } },
      raw: {},
    };
    expect(extractText(msg)).toBe('Direct string');
  });

  it('extracts and concatenates text blocks from content array', () => {
    const msg = {
      type: 'assistant' as const,
      payload: {
        message: {
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'tool_use', id: 'xyz', name: 'Bash', input: {} },
            { type: 'text', text: 'world' },
          ],
        },
      },
      raw: {},
    };
    expect(extractText(msg)).toBe('Hello world');
  });

  it('returns empty string for system message with no message field', () => {
    const msg = {
      type: 'system' as const,
      payload: {},
      raw: {},
    };
    expect(extractText(msg)).toBe('');
  });

  it('returns empty string for empty content array', () => {
    const msg = {
      type: 'assistant' as const,
      payload: { message: { content: [] } },
      raw: {},
    };
    expect(extractText(msg)).toBe('');
  });

  it('skips non-text blocks in content array', () => {
    const msg = {
      type: 'assistant' as const,
      payload: {
        message: {
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/out.txt' } },
            { type: 'tool_result', id: 'abc' },
          ],
        },
      },
      raw: {},
    };
    expect(extractText(msg)).toBe('');
  });
});
