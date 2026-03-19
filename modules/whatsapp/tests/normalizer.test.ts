import { normalize, toE164, epochToIso, mapMessageType } from '../src/normalizer';
import type { ValidatedInbound } from '../src/validator';

function makeTextValidated(overrides?: Partial<ValidatedInbound>): ValidatedInbound {
  return {
    messageId: 'MSG_001',
    from: '15551234567',
    timestamp: '1710000000',
    type: 'text',
    text: { body: 'Hello world' },
    phoneNumberId: 'PHONE_ID',
    ...overrides,
  };
}

function makeMediaValidated(overrides?: Partial<ValidatedInbound>): ValidatedInbound {
  return {
    messageId: 'MSG_002',
    from: '15551234567',
    timestamp: '1710000001',
    type: 'image',
    mediaFields: { image: { id: 'IMG_1', mime_type: 'image/jpeg' } },
    phoneNumberId: 'PHONE_ID',
    ...overrides,
  };
}

describe('toE164', () => {
  it('prepends + to phone number', () => {
    expect(toE164('15551234567')).toBe('+15551234567');
    expect(toE164('919876543210')).toBe('+919876543210');
  });
});

describe('epochToIso', () => {
  it('converts epoch seconds string to ISO string', () => {
    const result = epochToIso('1710000000');
    expect(result).toBe(new Date(1710000000 * 1000).toISOString());
  });

  it('correct ISO string for known epoch', () => {
    expect(epochToIso('1710000000')).toBe('2024-03-09T16:00:00.000Z');
  });
});

describe('mapMessageType', () => {
  it('maps text to text', () => {
    expect(mapMessageType('text')).toBe('text');
  });

  it('maps image to unsupported', () => {
    expect(mapMessageType('image')).toBe('unsupported');
  });

  it('maps audio to unsupported', () => {
    expect(mapMessageType('audio')).toBe('unsupported');
  });

  it('maps video to unsupported', () => {
    expect(mapMessageType('video')).toBe('unsupported');
  });

  it('maps unknown to unsupported', () => {
    expect(mapMessageType('sticker')).toBe('unsupported');
  });
});

describe('normalize: text message', () => {
  let result: ReturnType<typeof normalize>;

  beforeEach(() => {
    result = normalize(makeTextValidated());
  });

  it('maps message_id correctly', () => {
    expect(result.message_id).toBe('MSG_001');
  });

  it('phone gets + prefix', () => {
    expect(result.phone_number).toBe('+15551234567');
  });

  it('timestamp converts correctly', () => {
    expect(result.timestamp).toBe('2024-03-09T16:00:00.000Z');
  });

  it('correlation_id is valid UUID', () => {
    expect(result.correlation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('received_at is ISO string', () => {
    expect(() => new Date(result.received_at)).not.toThrow();
    expect(result.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('status is received', () => {
    expect(result.status).toBe('received');
  });

  it('message_type is text', () => {
    expect(result.message_type).toBe('text');
  });

  it('has text_body', () => {
    expect(result.text_body).toBe('Hello world');
  });

  it('no media_metadata', () => {
    expect(result.media_metadata).toBeUndefined();
  });
});

describe('normalize: media message', () => {
  let result: ReturnType<typeof normalize>;

  beforeEach(() => {
    result = normalize(makeMediaValidated());
  });

  it('message_type is unsupported', () => {
    expect(result.message_type).toBe('unsupported');
  });

  it('has media_metadata', () => {
    expect(result.media_metadata).toBeDefined();
    expect(result.media_metadata!['image']).toBeDefined();
  });

  it('no text_body', () => {
    expect(result.text_body).toBeUndefined();
  });

  it('status is received', () => {
    expect(result.status).toBe('received');
  });
});

describe('normalize: each call generates unique correlation_id', () => {
  it('two calls produce different UUIDs', () => {
    const r1 = normalize(makeTextValidated());
    const r2 = normalize(makeTextValidated());
    expect(r1.correlation_id).not.toBe(r2.correlation_id);
  });
});
