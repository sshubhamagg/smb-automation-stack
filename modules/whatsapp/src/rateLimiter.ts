import type { Store } from './store';
import type { Config } from './config';
import { log } from './logger';

let _store: Store | null = null;
let _config: {
  globalInbound: number;
  perUser: number;
  outbound: number;
  windowSeconds: number;
} = {
  globalInbound: 1000,
  perUser: 10,
  outbound: 100,
  windowSeconds: 60,
};

export function initRateLimiter(
  store: Store,
  config: Pick<
    Config,
    | 'rateLimitGlobalInbound'
    | 'rateLimitPerUser'
    | 'rateLimitOutbound'
    | 'rateLimitWindowSeconds'
  >
): void {
  _store = store;
  _config = {
    globalInbound: config.rateLimitGlobalInbound,
    perUser: config.rateLimitPerUser,
    outbound: config.rateLimitOutbound,
    windowSeconds: config.rateLimitWindowSeconds,
  };
}

export function buildKey(tier: string, identifier: string): string {
  return `ratelimit:${tier}:${identifier}`;
}

// Uses a fixed-window strategy. Counters reset at the start of each window.
// This may allow up to 2x the limit at window boundaries (burst at end + burst at start of next window).
async function check(
  key: string,
  limit: number,
  correlationId: string
): Promise<{ allowed: boolean; retryAfter: number }> {
  if (!_store) {
    return { allowed: true, retryAfter: 0 };
  }

  try {
    const count = await _store.incr(key, _config.windowSeconds);
    if (count > limit) {
      return { allowed: false, retryAfter: _config.windowSeconds };
    }
    return { allowed: true, retryAfter: 0 };
  } catch (err) {
    log({
      level: 'WARN',
      status: 'rate_limiter_store_error',
      correlationId,
      direction: 'inbound',
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: true, retryAfter: 0 };
  }
}

export async function checkGlobalInbound(): Promise<{ allowed: boolean; retryAfter: number }> {
  const key = buildKey('inbound', 'global');
  return check(key, _config.globalInbound, 'global-inbound');
}

export async function checkPerUser(
  phoneE164: string
): Promise<{ allowed: boolean; retryAfter: number }> {
  const key = buildKey('inbound', phoneE164);
  return check(key, _config.perUser, phoneE164);
}

export async function checkGlobalOutbound(): Promise<{ allowed: boolean; retryAfter: number }> {
  const key = buildKey('outbound', 'global');
  return check(key, _config.outbound, 'global-outbound');
}
