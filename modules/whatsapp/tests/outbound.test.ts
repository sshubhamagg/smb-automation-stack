import { sendMessage, buildRequestPayload, parseProviderResponse } from '../src/outbound';
import type { Config } from '../src/config';

function makeTestConfig(overrides?: Partial<Config>): Config {
  return Object.freeze({
    whatsappVerifyToken: 'test-verify-token',
    whatsappAppSecret: 'test-secret',
    whatsappApiToken: 'test-api-token',
    whatsappPhoneNumberId: 'TEST_PHONE_ID',
    storeBackend: 'sqlite' as const,
    redisUrl: 'redis://localhost:6379',
    sqlitePath: ':memory:',
    idempotencyTtlSeconds: 86400,
    rateLimitGlobalInbound: 1000,
    rateLimitPerUser: 10,
    rateLimitOutbound: 100,
    rateLimitWindowSeconds: 60,
    webhookTimeoutSeconds: 5,
    outboundTimeoutSeconds: 5,
    logLevel: 'ERROR' as const,
    logMaxPayloadBytes: 2048,
    port: 8000,
    ...overrides,
  });
}

function makeMockResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as unknown as Response;
}

describe('buildRequestPayload', () => {
  it('returns exact WhatsApp Cloud API shape', () => {
    const payload = buildRequestPayload('+15551234567', 'Hello', 'PHONE_ID');
    expect(payload).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '+15551234567',
      type: 'text',
      text: {
        preview_url: false,
        body: 'Hello',
      },
    });
  });
});

describe('parseProviderResponse', () => {
  it('on 200: extracts provider_message_id and returns accepted', async () => {
    const response = makeMockResponse(200, {
      messages: [{ id: 'wamid.123' }],
    });
    const result = await parseProviderResponse(response, 'corr-1');
    expect(result.status).toBe('accepted');
    expect(result.provider_message_id).toBe('wamid.123');
    expect(result.correlation_id).toBe('corr-1');
  });

  it('on 201: returns accepted', async () => {
    const response = makeMockResponse(201, {
      messages: [{ id: 'wamid.456' }],
    });
    const result = await parseProviderResponse(response, 'corr-2');
    expect(result.status).toBe('accepted');
  });

  it('on 400: returns failed with error details', async () => {
    const response = makeMockResponse(400, {
      error: { code: 100, message: 'Invalid parameter' },
    });
    const result = await parseProviderResponse(response, 'corr-3');
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_ERROR');
    expect(result.error?.message).toBe('Invalid parameter');
    expect(result.error?.provider_error_code).toBe(100);
  });

  it('on non-2xx without error body: returns failed', async () => {
    const response = makeMockResponse(500, {});
    const result = await parseProviderResponse(response, 'corr-4');
    expect(result.status).toBe('failed');
  });

  it('on JSON parse failure: returns failed with PROVIDER_ERROR', async () => {
    const badResponse = {
      status: 200,
      ok: true,
      json: async () => { throw new Error('Invalid JSON'); },
    } as unknown as Response;
    const result = await parseProviderResponse(badResponse, 'corr-5');
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_ERROR');
  });
});

describe('sendMessage', () => {
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('provider returns 200 → status accepted, provider_message_id set, correlation_id echoed', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeMockResponse(200, { messages: [{ id: 'wamid.abc' }] })
    );
    const config = makeTestConfig();
    const result = await sendMessage('+15551234567', 'Hello', 'corr-test', config);
    expect(result.status).toBe('accepted');
    expect(result.provider_message_id).toBe('wamid.abc');
    expect(result.correlation_id).toBe('corr-test');
  });

  it('provider returns 400 → status failed', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeMockResponse(400, { error: { code: 100, message: 'Bad param' } })
    );
    const config = makeTestConfig();
    const result = await sendMessage('+15551234567', 'Hello', 'corr-400', config);
    expect(result.status).toBe('failed');
  });

  it('fetch throws AbortError (timeout) → status failed, code PROVIDER_ERROR', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(abortError);
    const config = makeTestConfig({ outboundTimeoutSeconds: 1 });
    const result = await sendMessage('+15551234567', 'Hello', 'corr-abort', config);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_ERROR');
    expect(result.correlation_id).toBe('corr-abort');
  });

  it('network error (fetch rejects) → status failed', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network failure'));
    const config = makeTestConfig();
    const result = await sendMessage('+15551234567', 'Hello', 'corr-net', config);
    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('PROVIDER_ERROR');
  });

  it('sets Authorization: Bearer header', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      makeMockResponse(200, { messages: [{ id: 'wamid.xyz' }] })
    );
    const config = makeTestConfig();
    await sendMessage('+15551234567', 'Hello', 'corr-auth', config);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-api-token');
  });

  it('no retry: provider 500 → single attempt, status failed', async () => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeMockResponse(500, {})
    );
    const config = makeTestConfig();
    const result = await sendMessage('+15551234567', 'Hello', 'corr-500', config);
    expect(result.status).toBe('failed');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
