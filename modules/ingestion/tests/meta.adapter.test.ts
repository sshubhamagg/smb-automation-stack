import { MetaAdapter } from '../src/adapters/meta';
import type { IngestionInput } from '../src/types';

// jest.mock paths are relative to THIS test file.
// Both resolve to the same absolute path as the adapter's relative imports.
jest.mock('../../whatsapp/src/validator', () => ({
  verifySignature: jest.fn(),
  validateInbound: jest.fn(),
  ValidationError: class ValidationError extends Error {
    code: string;
    field?: string;
    constructor(code: string, message: string, field?: string) {
      super(message);
      this.name = 'ValidationError';
      this.code = code;
      this.field = field;
    }
  },
}));

jest.mock('../../whatsapp/src/normalizer', () => ({
  normalize: jest.fn(),
}));

const validatorMock = jest.requireMock('../../whatsapp/src/validator') as {
  verifySignature: jest.Mock;
  validateInbound: jest.Mock;
};

const normalizerMock = jest.requireMock('../../whatsapp/src/normalizer') as {
  normalize: jest.Mock;
};

// ── fixtures ────────────────────────────────────────────────────────────────

const mockValidated = {
  messageId: 'wamid.test123',
  from: '917017875169',
  timestamp: '1710000000',
  type: 'text',
  text: { body: 'Hello world' },
  phoneNumberId: 'phone-num-id-123',
};

const mockNormalized = {
  message_id: 'wamid.test123',
  correlation_id: 'corr-uuid-abc',
  phone_number: '+917017875169',
  timestamp: '2024-03-09T22:13:20.000Z',
  message_type: 'text' as const,
  text_body: 'Hello world',
  status: 'received' as const,
  received_at: '2024-03-09T22:14:00.000Z',
};

const baseInput: IngestionInput = {
  source: 'whatsapp',
  provider: 'meta',
  payload: { entry: [] },
};

// ── tests ────────────────────────────────────────────────────────────────────

describe('MetaAdapter', () => {
  let adapter: MetaAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new MetaAdapter();
  });

  // ── valid message ──────────────────────────────────────────────────────────

  describe('valid message', () => {
    it('returns ok:true with a fully mapped NormalizedEvent', async () => {
      validatorMock.validateInbound.mockReturnValue(mockValidated);
      normalizerMock.normalize.mockReturnValue(mockNormalized);

      const result = await adapter.execute(baseInput);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.event.source).toBe('whatsapp');
      expect(result.event.provider).toBe('meta');
      expect(result.event.userId).toBe('+917017875169');
      expect(result.event.message).toBe('Hello world');
      expect(result.event.timestamp).toBe(Date.parse('2024-03-09T22:13:20.000Z'));
      expect(result.event.raw).toBe(baseInput.payload);
      expect(result.event.metadata?.messageId).toBe('wamid.test123');
      expect(result.event.metadata?.correlationId).toBe('corr-uuid-abc');
      expect(result.event.metadata?.messageType).toBe('text');
      expect(result.event.metadata?.status).toBe('received');
      expect(result.event.metadata?.phoneNumberId).toBe('phone-num-id-123');
    });

    it('skips signature check when rawBody / headers / secret are absent', async () => {
      validatorMock.validateInbound.mockReturnValue(mockValidated);
      normalizerMock.normalize.mockReturnValue(mockNormalized);

      await adapter.execute(baseInput);

      expect(validatorMock.verifySignature).not.toHaveBeenCalled();
    });

    it('verifies signature and proceeds when signature is valid', async () => {
      validatorMock.verifySignature.mockReturnValue(true);
      validatorMock.validateInbound.mockReturnValue(mockValidated);
      normalizerMock.normalize.mockReturnValue(mockNormalized);

      const inputWithSig: IngestionInput = {
        ...baseInput,
        rawBody: Buffer.from('{}'),
        headers: { 'x-hub-signature-256': 'sha256=abc123' },
        secret: 'my-secret',
      };

      const result = await adapter.execute(inputWithSig);

      expect(validatorMock.verifySignature).toHaveBeenCalledWith(
        inputWithSig.rawBody,
        'sha256=abc123',
        'my-secret'
      );
      expect(result.ok).toBe(true);
    });
  });

  // ── signature failure ──────────────────────────────────────────────────────

  describe('signature failure', () => {
    it('returns signature_invalid and does not call validateInbound', async () => {
      validatorMock.verifySignature.mockReturnValue(false);

      const inputWithSig: IngestionInput = {
        ...baseInput,
        rawBody: Buffer.from('{}'),
        headers: { 'x-hub-signature-256': 'sha256=wrong' },
        secret: 'my-secret',
      };

      const result = await adapter.execute(inputWithSig);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('signature_invalid');
      expect(validatorMock.validateInbound).not.toHaveBeenCalled();
    });
  });

  // ── status update ──────────────────────────────────────────────────────────

  describe('status update', () => {
    it('returns status_update when validateInbound returns null', async () => {
      validatorMock.validateInbound.mockReturnValue(null);

      const result = await adapter.execute(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('status_update');
      expect(normalizerMock.normalize).not.toHaveBeenCalled();
    });
  });

  // ── unsupported type ───────────────────────────────────────────────────────

  describe('unsupported type', () => {
    it('returns unsupported_type with the actual type for image messages', async () => {
      validatorMock.validateInbound.mockReturnValue({ ...mockValidated, type: 'image' });

      const result = await adapter.execute(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unsupported_type');
      if (result.reason !== 'unsupported_type') return;
      expect(result.type).toBe('image');
      expect(normalizerMock.normalize).not.toHaveBeenCalled();
    });

    it('returns unsupported_type for audio messages', async () => {
      validatorMock.validateInbound.mockReturnValue({ ...mockValidated, type: 'audio' });

      const result = await adapter.execute(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('unsupported_type');
    });
  });

  // ── validation failure ─────────────────────────────────────────────────────

  describe('validation failure', () => {
    it('returns validation_failed when validateInbound throws a ValidationError', async () => {
      const { ValidationError } = jest.requireMock('../../whatsapp/src/validator') as {
        ValidationError: new (code: string, msg: string) => Error;
      };
      validatorMock.validateInbound.mockImplementation(() => {
        throw new ValidationError('INVALID_PAYLOAD', 'entry array is empty');
      });

      const result = await adapter.execute(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('validation_failed');
      if (result.reason !== 'validation_failed') return;
      expect(result.error).toBe('entry array is empty');
    });

    it('returns validation_failed when validateInbound throws a generic error', async () => {
      validatorMock.validateInbound.mockImplementation(() => {
        throw new Error('Unexpected structure');
      });

      const result = await adapter.execute(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('validation_failed');
    });
  });
});
