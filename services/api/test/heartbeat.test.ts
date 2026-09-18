import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The dead-man's switch (docs/RUNBOOK.md → "Alerting"). What matters is not
 * that it calls Sentry but *what it tells Sentry*: the schedule it upserts is
 * what decides how long a dead API stays unnoticed, and a failing probe has to
 * arrive as `error`, not as silence.
 */
const captureCheckIn = vi.fn();
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  setTags: vi.fn(),
  withScope: vi.fn(),
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(() => 'event-id'),
  captureCheckIn: (...args: unknown[]) => captureCheckIn(...args),
}));

const { loadConfig } = await import('../src/config.js');
const { setSentryEnabledForTests, startCronHeartbeat } = await import('../src/observability.js');

function config(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    PEN_JWT_SECRET: 'heartbeat-secret-heartbeat-secret-x',
    PEN_LLM_PROVIDER: 'fake',
    PEN_TTS_PROVIDER: 'silent',
    SENTRY_CRON_MONITOR_SLUG: 'pen-api-heartbeat',
    ...extra,
  });
}

beforeEach(() => {
  captureCheckIn.mockClear();
  setSentryEnabledForTests(true);
});
afterEach(() => setSentryEnabledForTests(false));

describe('sentry cron heartbeat', () => {
  it('checks in at boot with a schedule that turns silence into an issue within two intervals', async () => {
    const stop = startCronHeartbeat(config(), async () => true);
    expect(stop).not.toBeNull();
    await vi.waitFor(() => expect(captureCheckIn).toHaveBeenCalledTimes(1));

    const [checkIn, monitorConfig] = captureCheckIn.mock.calls[0] as [
      { monitorSlug: string; status: string; duration: number },
      {
        schedule: { type: string; value: number; unit: string };
        checkinMargin: number;
        failureIssueThreshold: number;
        recoveryThreshold: number;
        timezone: string;
      },
    ];
    expect(checkIn.monitorSlug).toBe('pen-api-heartbeat');
    expect(checkIn.status).toBe('ok');
    expect(checkIn.duration).toBeGreaterThanOrEqual(0);
    // 5-minute interval + 5-minute margin, issue on the first miss: ≤ 10 minutes.
    expect(monitorConfig.schedule).toEqual({ type: 'interval', value: 5, unit: 'minute' });
    expect(monitorConfig.checkinMargin).toBe(5);
    expect(monitorConfig.failureIssueThreshold).toBe(1);
    expect(monitorConfig.recoveryThreshold).toBe(1);
    expect(monitorConfig.timezone).toBe('Etc/UTC');
    stop?.();
  });

  it('reports a failing readiness probe as an error check-in, and a throwing one too', async () => {
    const stop = startCronHeartbeat(config(), async () => false);
    await vi.waitFor(() => expect(captureCheckIn).toHaveBeenCalledTimes(1));
    expect((captureCheckIn.mock.calls[0] as [{ status: string }])[0].status).toBe('error');
    stop?.();

    captureCheckIn.mockClear();
    const stopThrowing = startCronHeartbeat(config(), async () => {
      throw new Error('database is down');
    });
    await vi.waitFor(() => expect(captureCheckIn).toHaveBeenCalledTimes(1));
    expect((captureCheckIn.mock.calls[0] as [{ status: string }])[0].status).toBe('error');
    stopThrowing?.();
  });

  it('repeats on the configured interval and stops when told to', async () => {
    vi.useFakeTimers();
    try {
      const stop = startCronHeartbeat(
        config({ SENTRY_CRON_INTERVAL_MINUTES: '1' }),
        async () => true,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(captureCheckIn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(captureCheckIn).toHaveBeenCalledTimes(2);
      const [, monitorConfig] = captureCheckIn.mock.calls[1] as [
        unknown,
        { schedule: { value: number } },
      ];
      expect(monitorConfig.schedule.value).toBe(1);
      stop?.();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(captureCheckIn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing without a slug, and refuses to pretend without a DSN', async () => {
    expect(
      startCronHeartbeat(
        loadConfig({
          NODE_ENV: 'test',
          PEN_JWT_SECRET: 'heartbeat-secret-heartbeat-secret-x',
          PEN_LLM_PROVIDER: 'fake',
          PEN_TTS_PROVIDER: 'silent',
        }),
        async () => true,
      ),
    ).toBeNull();

    setSentryEnabledForTests(false);
    expect(startCronHeartbeat(config(), async () => true)).toBeNull();
    expect(captureCheckIn).not.toHaveBeenCalled();
  });
});
