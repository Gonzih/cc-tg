import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detectUsageLimit } from "./usage-limit.js";

describe("detectUsageLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fix "now" to a known time: 2026-03-22T10:30:00Z
    vi.setSystemTime(new Date("2026-03-22T10:30:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns not-detected for normal text", () => {
    const sig = detectUsageLimit("Here is a response about your code.");
    expect(sig.detected).toBe(false);
    expect(sig.retryAfterMs).toBe(0);
    expect(sig.humanMessage).toBe("");
  });

  it("detects 'usage limit' phrase", () => {
    const sig = detectUsageLimit("You have reached your usage limit for this period.");
    expect(sig.detected).toBe(true);
    expect(sig.reason).toBe("usage_exhausted");
    expect(sig.retryAfterMs).toBeGreaterThan(0);
    expect(sig.humanMessage).toContain("⏸ Claude usage limit reached");
    expect(sig.humanMessage).toContain("auto-resume");
  });

  it("detects 'extra usage' phrase", () => {
    const sig = detectUsageLimit("You need extra usage to continue.");
    expect(sig.detected).toBe(true);
    expect(sig.reason).toBe("usage_exhausted");
  });

  it("detects 'usage has been disabled' phrase", () => {
    const sig = detectUsageLimit("Your usage has been disabled.");
    expect(sig.detected).toBe(true);
    expect(sig.reason).toBe("usage_exhausted");
  });

  it("detects 'billing_error' phrase", () => {
    const sig = detectUsageLimit("Error: billing_error encountered.");
    expect(sig.detected).toBe(true);
    expect(sig.reason).toBe("usage_exhausted");
  });

  it("is case-insensitive for usage limit", () => {
    const sig = detectUsageLimit("USAGE LIMIT exceeded.");
    expect(sig.detected).toBe(true);
    expect(sig.reason).toBe("usage_exhausted");
  });

  it("detects 'rate limit'", () => {
    const sig = detectUsageLimit("Error: rate limit exceeded.");
    expect(sig.detected).toBe(true);
    expect(sig.reason).toBe("rate_limit");
    expect(sig.retryAfterMs).toBe(2 * 60 * 1000);
    expect(sig.humanMessage).toContain("⏸ Rate limited");
    expect(sig.humanMessage).toContain("2 minutes");
  });

  it("detects 'overloaded'", () => {
    const sig = detectUsageLimit("The service is overloaded, please try again.");
    expect(sig.detected).toBe(true);
    expect(sig.reason).toBe("rate_limit");
    expect(sig.retryAfterMs).toBe(2 * 60 * 1000);
  });

  it("usage_exhausted retryAfterMs targets next hour boundary + 5 min", () => {
    // Now is 10:30, next hour boundary is 11:00 + 5min = 11:05
    const sig = detectUsageLimit("usage limit reached");
    const expectedMs = new Date("2026-03-22T11:05:00Z").getTime() - new Date("2026-03-22T10:30:00Z").getTime();
    expect(sig.retryAfterMs).toBe(expectedMs);
  });

  it("humanMessage includes the wake time UTC string", () => {
    const sig = detectUsageLimit("usage limit reached");
    const wakeDate = new Date("2026-03-22T11:05:00Z");
    expect(sig.humanMessage).toContain(wakeDate.toUTCString());
  });
});
