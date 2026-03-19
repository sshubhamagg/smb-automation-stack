import { initIdempotency, checkAndLock, writeOutput, buildKey } from '../src/idempotency';
import type { Store } from '../src/store';
import type { NormalizedMessage } from '../src/normalizer';

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

function makeNormalizedMessage(overrides?: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    message_id: 'MSG_001',
    correlation_id: 'corr-001',
    phone_number: '+15551234567',
    timestamp: '2024-03-09T17:20:00.000Z',
    message_type: 'text',
    text_body: 'Hello',
    status: 'received',
    received_at: '2024-03-09T17:20:01.000Z',
    ...overrides,
  };
}

describe('buildKey', () => {
  it('returns correct idempotency key', () => {
    expect(buildKey('test-id')).toBe('idempotency:test-id');
  });
});

describe('checkAndLock', () => {
  let mockStore: jest.Mocked<Store>;

  beforeEach(() => {
    mockStore = makeMockStore();
    initIdempotency(mockStore, 86400);
  });

  it('new message: setnx returns true → { isNew: true, cachedOutput: null }', async () => {
    mockStore.setnx.mockResolvedValueOnce(true);
    const result = await checkAndLock('MSG_001');
    expect(result).toEqual({ isNew: true, cachedOutput: null });
    expect(mockStore.setnx).toHaveBeenCalledWith('idempotency:MSG_001', 'processing', 86400);
  });

  it('duplicate with cached output: setnx false, get returns JSON', async () => {
    const cached = makeNormalizedMessage();
    mockStore.setnx.mockResolvedValueOnce(false);
    mockStore.get.mockResolvedValueOnce(JSON.stringify(cached));
    const result = await checkAndLock('MSG_001');
    expect(result.isNew).toBe(false);
    expect(result.cachedOutput).toEqual(cached);
  });

  it('duplicate with processing sentinel: setnx false, get returns "processing"', async () => {
    mockStore.setnx.mockResolvedValueOnce(false);
    mockStore.get.mockResolvedValueOnce('processing');
    const result = await checkAndLock('MSG_001');
    expect(result).toEqual({ isNew: false, cachedOutput: null });
  });

  it('duplicate with null: setnx false, get returns null', async () => {
    mockStore.setnx.mockResolvedValueOnce(false);
    mockStore.get.mockResolvedValueOnce(null);
    const result = await checkAndLock('MSG_001');
    expect(result).toEqual({ isNew: false, cachedOutput: null });
  });

  it('store error on setnx throws → { isNew: true, cachedOutput: null }', async () => {
    mockStore.setnx.mockRejectedValueOnce(new Error('Redis connection failed'));
    const result = await checkAndLock('MSG_001');
    expect(result).toEqual({ isNew: true, cachedOutput: null });
  });

  it('duplicate with invalid JSON: returns { isNew: false, cachedOutput: null }', async () => {
    mockStore.setnx.mockResolvedValueOnce(false);
    mockStore.get.mockResolvedValueOnce('{invalid json}');
    const result = await checkAndLock('MSG_001');
    expect(result).toEqual({ isNew: false, cachedOutput: null });
  });
});

describe('writeOutput', () => {
  let mockStore: jest.Mocked<Store>;

  beforeEach(() => {
    mockStore = makeMockStore();
    mockStore.set.mockResolvedValue(undefined);
    initIdempotency(mockStore, 86400);
  });

  it('calls store.set with correct key and TTL', async () => {
    const output = makeNormalizedMessage();
    await writeOutput('MSG_001', output);
    expect(mockStore.set).toHaveBeenCalledWith(
      'idempotency:MSG_001',
      JSON.stringify(output),
      86400
    );
  });

  it('does not throw if store.set fails', async () => {
    mockStore.set.mockRejectedValueOnce(new Error('Store error'));
    const output = makeNormalizedMessage();
    await expect(writeOutput('MSG_001', output)).resolves.not.toThrow();
  });
});
