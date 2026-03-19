import { createHmac } from 'node:crypto';
import { buildApp } from '../src/main';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../src/config';
import type { Store } from '../src/store';

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

function makeMockStore(): jest.Mocked<Store> {
  return {
    get: jest.fn().mockResolvedValue(null),
    setnx: jest.fn().mockResolvedValue(true),
    set: jest.fn().mockResolvedValue(undefined),
    incr: jest.fn().mockResolvedValue(1),
    ping: jest.fn().mockResolvedValue(true),
    disconnect: jest.fn().mockResolvedValue(undefined),
  };
}

function computeSignature(body: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  return `sha256=${hex}`;
}

function makeTextWebhookPayload(overrides?: {
  messageId?: string;
  from?: string;
  timestamp?: string;
  body?: string;
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'ENTRY_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15551234567',
                phone_number_id: 'TEST_PHONE_ID',
              },
              messages: [
                {
                  id: overrides?.messageId ?? 'MSG_001',
                  from: overrides?.from ?? '15551234567',
                  timestamp: overrides?.timestamp ?? '1710000000',
                  type: 'text',
                  text: { body: overrides?.body ?? 'Hello world' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function makeMediaWebhookPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'ENTRY_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15551234567',
                phone_number_id: 'TEST_PHONE_ID',
              },
              messages: [
                {
                  id: 'MSG_MEDIA',
                  from: '15551234567',
                  timestamp: '1710000000',
                  type: 'image',
                  image: { id: 'IMG_1', mime_type: 'image/jpeg', sha256: 'abc' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function makeStatusUpdatePayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'ENTRY_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15551234567',
                phone_number_id: 'TEST_PHONE_ID',
              },
              statuses: [{ id: 'MSG_001', status: 'delivered' }],
            },
          },
        ],
      },
    ],
  };
}

describe('WhatsApp Handler Integration', () => {
  let app: FastifyInstance;
  let mockStore: jest.Mocked<Store>;
  const testConfig = makeTestConfig();

  beforeEach(async () => {
    mockStore = makeMockStore();
    app = await buildApp(testConfig, mockStore);
  });

  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
    jest.clearAllTimers();
  });

  describe('POST /webhook', () => {
    it('happy path: valid signature + text payload → 200 + normalized output', async () => {
      const payload = makeTextWebhookPayload();
      const body = JSON.stringify(payload);
      const sig = computeSignature(body, 'test-secret');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json<Record<string, unknown>>();
      expect(json['message_id']).toBe('MSG_001');
      expect(json['phone_number']).toBe('+15551234567');
      expect(json['message_type']).toBe('text');
      expect(json['status']).toBe('received');
    });

    it('duplicate: setnx returns false, get returns cached JSON → 200 + status duplicate', async () => {
      const cached = {
        message_id: 'MSG_001',
        correlation_id: 'old-corr',
        phone_number: '+15551234567',
        timestamp: '2024-03-09T17:20:00.000Z',
        message_type: 'text',
        text_body: 'Hello world',
        status: 'received',
        received_at: '2024-03-09T17:20:01.000Z',
      };
      mockStore.setnx.mockResolvedValue(false);
      mockStore.get.mockResolvedValue(JSON.stringify(cached));

      const payload = makeTextWebhookPayload();
      const body = JSON.stringify(payload);
      const sig = computeSignature(body, 'test-secret');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json<Record<string, unknown>>();
      expect(json['status']).toBe('duplicate');
    });

    it('invalid signature → 401 + SIGNATURE_INVALID', async () => {
      const payload = makeTextWebhookPayload();
      const body = JSON.stringify(payload);

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': 'sha256=deadbeef',
        },
        payload: body,
      });

      expect(response.statusCode).toBe(401);
      const json = response.json<Record<string, unknown>>();
      expect(json['code']).toBe('SIGNATURE_INVALID');
    });

    it('missing object field → 400 + INVALID_PAYLOAD', async () => {
      const badPayload = { entry: [] };
      const body = JSON.stringify(badPayload);
      const sig = computeSignature(body, 'test-secret');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(400);
      const json = response.json<Record<string, unknown>>();
      expect(json['error']).toBe(true);
    });

    it('global rate limit: incr returns rateLimitGlobalInbound+1 → 429', async () => {
      mockStore.incr.mockResolvedValue(testConfig.rateLimitGlobalInbound + 1);
      const payload = makeTextWebhookPayload();
      const body = JSON.stringify(payload);
      const sig = computeSignature(body, 'test-secret');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(429);
    });

    it('status update (no messages) → 200 + { status: ok }', async () => {
      const payload = makeStatusUpdatePayload();
      const body = JSON.stringify(payload);
      const sig = computeSignature(body, 'test-secret');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json<Record<string, unknown>>();
      expect(json['status']).toBe('ok');
    });

    it('media message → 200 + message_type unsupported + media_metadata', async () => {
      const payload = makeMediaWebhookPayload();
      const body = JSON.stringify(payload);
      const sig = computeSignature(body, 'test-secret');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json<Record<string, unknown>>();
      expect(json['message_type']).toBe('unsupported');
      expect(json['media_metadata']).toBeDefined();
    });

    it('multi-message payload → 200 + only first message processed', async () => {
      const multiPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'ENTRY_ID',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15551234567',
                    phone_number_id: 'TEST_PHONE_ID',
                  },
                  messages: [
                    {
                      id: 'MSG_FIRST',
                      from: '15551234567',
                      timestamp: '1710000000',
                      type: 'text',
                      text: { body: 'First' },
                    },
                    {
                      id: 'MSG_SECOND',
                      from: '15551234567',
                      timestamp: '1710000001',
                      type: 'text',
                      text: { body: 'Second' },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      const body = JSON.stringify(multiPayload);
      const sig = computeSignature(body, 'test-secret');

      const response = await app.inject({
        method: 'POST',
        url: '/webhook',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': sig,
        },
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json<Record<string, unknown>>();
      expect(json['message_id']).toBe('MSG_FIRST');
    });
  });

  describe('GET /webhook', () => {
    it('valid verify token → 200 + challenge', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/webhook',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'test-verify-token',
          'hub.challenge': 'CHALLENGE_TOKEN_123',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('CHALLENGE_TOKEN_123');
    });

    it('invalid token → 403', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/webhook',
        query: {
          'hub.mode': 'subscribe',
          'hub.verify_token': 'wrong-token',
          'hub.challenge': 'CHALLENGE_TOKEN',
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe('POST /send', () => {
    it('valid request, mock fetch returns 200 → 200 + status accepted', async () => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ messages: [{ id: 'wamid.999' }] }),
        headers: new Headers(),
      } as unknown as Response);

      const response = await app.inject({
        method: 'POST',
        url: '/send',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          recipient: '+15551234567',
          text: 'Hello from send',
          correlationId: 'corr-send-1',
        }),
      });

      expect(response.statusCode).toBe(200);
      const json = response.json<Record<string, unknown>>();
      expect(json['status']).toBe('accepted');
    });

    it('missing recipient → 400 + MISSING_FIELD', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/send',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({
          text: 'Hello',
          correlationId: 'corr-send-2',
        }),
      });

      expect(response.statusCode).toBe(400);
      const json = response.json<Record<string, unknown>>();
      expect(json['code']).toBe('MISSING_FIELD');
    });
  });

  describe('GET /health', () => {
    it('store ok → 200 + { status: ok, store: ok }', async () => {
      mockStore.ping.mockResolvedValue(true);
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json<Record<string, unknown>>();
      expect(json['status']).toBe('ok');
      expect(json['store']).toBe('ok');
      expect(json['service']).toBe('ok');
      expect(json['timestamp']).toBeDefined();
    });

    it('store unreachable: ping returns false → 200 + { status: degraded }', async () => {
      mockStore.ping.mockResolvedValue(false);
      const response = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const json = response.json<Record<string, unknown>>();
      expect(json['status']).toBe('degraded');
      expect(json['store']).toBe('unreachable');
    });
  });
});
