import {
  initRateLimiter,
  buildKey,
  checkGlobalInbound,
  checkPerUser,
  checkGlobalOutbound,
} from '../src/rateLimiter';
import type { Store } from '../src/store';

function makeMockStore(): jest.Mocked<Store> {
  return {
    get: jest.fn(),
    setnx: jest.fn(),
    set: jest.fn(),
    incr: jest.fn(),
    ping: jest.fn(),
    disconnect: jest.fn(),
  };
}

const testConfig = {
  rateLimitGlobalInbound: 100,
  rateLimitPerUser: 5,
  rateLimitOutbound: 50,
  rateLimitWindowSeconds: 60,
};

afterEach(() => {
  jest.clearAllTimers();
});

describe('buildKey', () => {
  it('returns correct key for inbound global', () => {
    expect(buildKey('inbound', 'global')).toBe('ratelimit:inbound:global');
  });

  it('returns correct key for user', () => {
    expect(buildKey('inbound', '+15551234567')).toBe('ratelimit:inbound:+15551234567');
  });

  it('returns correct key for outbound', () => {
    expect(buildKey('outbound', 'global')).toBe('ratelimit:outbound:global');
  });
});

describe('checkGlobalInbound', () => {
  let mockStore: jest.Mocked<Store>;

  beforeEach(() => {
    mockStore = makeMockStore();
    initRateLimiter(mockStore, testConfig);
  });

  it('first request (incr returns 1) → allowed', async () => {
    mockStore.incr.mockResolvedValueOnce(1);
    const result = await checkGlobalInbound();
    expect(result).toEqual({ allowed: true, retryAfter: 0 });
  });

  it('below limit → allowed', async () => {
    mockStore.incr.mockResolvedValueOnce(50);
    const result = await checkGlobalInbound();
    expect(result).toEqual({ allowed: true, retryAfter: 0 });
  });

  it('at limit → not allowed', async () => {
    mockStore.incr.mockResolvedValueOnce(testConfig.rateLimitGlobalInbound + 1);
    const result = await checkGlobalInbound();
    expect(result).toEqual({ allowed: false, retryAfter: testConfig.rateLimitWindowSeconds });
  });

  it('exactly at limit → not allowed', async () => {
    mockStore.incr.mockResolvedValueOnce(testConfig.rateLimitGlobalInbound + 1);
    const result = await checkGlobalInbound();
    expect(result.allowed).toBe(false);
  });

  it('store error → { allowed: true, retryAfter: 0 }', async () => {
    mockStore.incr.mockRejectedValueOnce(new Error('Redis error'));
    const result = await checkGlobalInbound();
    expect(result).toEqual({ allowed: true, retryAfter: 0 });
  });

  it('calls incr with correct key', async () => {
    mockStore.incr.mockResolvedValueOnce(1);
    await checkGlobalInbound();
    expect(mockStore.incr).toHaveBeenCalledWith('ratelimit:inbound:global', testConfig.rateLimitWindowSeconds);
  });
});

describe('checkPerUser', () => {
  let mockStore: jest.Mocked<Store>;

  beforeEach(() => {
    mockStore = makeMockStore();
    initRateLimiter(mockStore, testConfig);
  });

  it('first request → allowed', async () => {
    mockStore.incr.mockResolvedValueOnce(1);
    const result = await checkPerUser('+15551234567');
    expect(result).toEqual({ allowed: true, retryAfter: 0 });
  });

  it('at limit → not allowed', async () => {
    mockStore.incr.mockResolvedValueOnce(testConfig.rateLimitPerUser + 1);
    const result = await checkPerUser('+15551234567');
    expect(result).toEqual({ allowed: false, retryAfter: testConfig.rateLimitWindowSeconds });
  });

  it('different users are independent', async () => {
    mockStore.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(testConfig.rateLimitPerUser + 1);
    const result1 = await checkPerUser('+15551111111');
    const result2 = await checkPerUser('+15552222222');
    expect(result1.allowed).toBe(true);
    expect(result2.allowed).toBe(false);
  });

  it('calls incr with user-specific key', async () => {
    mockStore.incr.mockResolvedValueOnce(1);
    await checkPerUser('+15551234567');
    expect(mockStore.incr).toHaveBeenCalledWith(
      'ratelimit:inbound:+15551234567',
      testConfig.rateLimitWindowSeconds
    );
  });

  it('store error → { allowed: true, retryAfter: 0 }', async () => {
    mockStore.incr.mockRejectedValueOnce(new Error('Store error'));
    const result = await checkPerUser('+15551234567');
    expect(result).toEqual({ allowed: true, retryAfter: 0 });
  });
});

describe('checkGlobalOutbound', () => {
  let mockStore: jest.Mocked<Store>;

  beforeEach(() => {
    mockStore = makeMockStore();
    initRateLimiter(mockStore, testConfig);
  });

  it('below limit → allowed', async () => {
    mockStore.incr.mockResolvedValueOnce(1);
    const result = await checkGlobalOutbound();
    expect(result).toEqual({ allowed: true, retryAfter: 0 });
  });

  it('at limit → not allowed', async () => {
    mockStore.incr.mockResolvedValueOnce(testConfig.rateLimitOutbound + 1);
    const result = await checkGlobalOutbound();
    expect(result).toEqual({ allowed: false, retryAfter: testConfig.rateLimitWindowSeconds });
  });

  it('calls incr with outbound key', async () => {
    mockStore.incr.mockResolvedValueOnce(1);
    await checkGlobalOutbound();
    expect(mockStore.incr).toHaveBeenCalledWith('ratelimit:outbound:global', testConfig.rateLimitWindowSeconds);
  });

  it('store error → { allowed: true, retryAfter: 0 }', async () => {
    mockStore.incr.mockRejectedValueOnce(new Error('Store error'));
    const result = await checkGlobalOutbound();
    expect(result).toEqual({ allowed: true, retryAfter: 0 });
  });
});
