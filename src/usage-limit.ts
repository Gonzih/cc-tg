export interface UsageLimitSignal {
  detected: boolean;
  reason: 'usage_exhausted' | 'rate_limit';
  retryAfterMs: number;
  humanMessage: string;
}

export function detectUsageLimit(text: string): UsageLimitSignal {
  const lower = text.toLowerCase();
  if (
    lower.includes('extra usage') ||
    lower.includes('usage has been disabled') ||
    lower.includes('billing_error') ||
    lower.includes('usage limit')
  ) {
    const wake = nextHourBoundary() + 5 * 60 * 1000;
    return {
      detected: true,
      reason: 'usage_exhausted',
      retryAfterMs: wake - Date.now(),
      humanMessage: `⏸ Claude usage limit reached. Will auto-resume at ${new Date(wake).toUTCString()}. I'll message you when it's back.`,
    };
  }
  if (lower.includes('rate limit') || lower.includes('overloaded')) {
    return {
      detected: true,
      reason: 'rate_limit',
      retryAfterMs: 2 * 60 * 1000,
      humanMessage: `⏸ Rate limited. Retrying in 2 minutes...`,
    };
  }
  return { detected: false, reason: 'rate_limit', retryAfterMs: 0, humanMessage: '' };
}

function nextHourBoundary(): number {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d.getTime();
}
