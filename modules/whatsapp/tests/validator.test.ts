import { createHmac } from 'node:crypto';
import {
  verifySignature,
  validateInbound,
  isE164,
  validateOutbound,
  ValidationError,
} from '../src/validator';

function makeWebhookPayload(overrides?: Record<string, unknown>) {
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
                phone_number_id: 'PHONE_NUMBER_ID',
              },
              messages: [
                {
                  id: 'MESSAGE_ID',
                  from: '15551234567',
                  timestamp: '1710000000',
                  type: 'text',
                  text: { body: 'Hello world' },
                },
              ],
              ...overrides,
            },
          },
        ],
      },
    ],
  };
}

function makeSignature(body: string, secret: string): string {
  const hex = createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  return `sha256=${hex}`;
}

describe('verifySignature', () => {
  const secret = 'test-secret';
  const body = '{"test":"payload"}';
  const bodyBuffer = Buffer.from(body);

  it('returns true for valid signature', () => {
    const sig = makeSignature(body, secret);
    expect(verifySignature(bodyBuffer, sig, secret)).toBe(true);
  });

  it('returns false for invalid signature', () => {
    expect(verifySignature(bodyBuffer, 'sha256=deadbeef', secret)).toBe(false);
  });

  it('returns false for missing sha256= prefix', () => {
    const hex = createHmac('sha256', secret).update(bodyBuffer).digest('hex');
    expect(verifySignature(bodyBuffer, hex, secret)).toBe(false);
  });

  it('returns false for length mismatch (odd-length hex)', () => {
    expect(verifySignature(bodyBuffer, 'sha256=abc', secret)).toBe(false);
  });

  it('returns false for empty header', () => {
    expect(verifySignature(bodyBuffer, '', secret)).toBe(false);
  });
});

describe('validateInbound', () => {
  it('happy path: text message', () => {
    const payload = makeWebhookPayload();
    const result = validateInbound(payload);
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe('MESSAGE_ID');
    expect(result!.from).toBe('15551234567');
    expect(result!.timestamp).toBe('1710000000');
    expect(result!.type).toBe('text');
    expect(result!.text).toEqual({ body: 'Hello world' });
    expect(result!.phoneNumberId).toBe('PHONE_NUMBER_ID');
  });

  it('happy path: media message returns mediaFields', () => {
    const payload = {
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
                  phone_number_id: 'PHONE_NUMBER_ID',
                },
                messages: [
                  {
                    id: 'MSG_MEDIA',
                    from: '15551234567',
                    timestamp: '1710000001',
                    type: 'image',
                    image: { id: 'IMG_ID', mime_type: 'image/jpeg', sha256: 'abc' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const result = validateInbound(payload);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('image');
    expect(result!.mediaFields).toBeDefined();
    expect(result!.mediaFields!['image']).toBeDefined();
    expect(result!.text).toBeUndefined();
  });

  it('returns null when messages array is absent (status update)', () => {
    const payload = {
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
                  phone_number_id: 'PHONE_NUMBER_ID',
                },
                statuses: [{ id: 'MSG_ID', status: 'delivered' }],
              },
            },
          ],
        },
      ],
    };
    const result = validateInbound(payload);
    expect(result).toBeNull();
  });

  it('throws ValidationError for missing entry array', () => {
    expect(() => validateInbound({ object: 'whatsapp_business_account' })).toThrow(ValidationError);
  });

  it('throws ValidationError for invalid messaging_product', () => {
    const payload = makeWebhookPayload();
    (payload.entry[0].changes[0].value as Record<string, unknown>)['messaging_product'] = 'telegram';
    expect(() => validateInbound(payload)).toThrow(ValidationError);
  });

  it('throws ValidationError for missing messages[0].id', () => {
    const payload = makeWebhookPayload();
    const messages = (payload.entry[0].changes[0].value as Record<string, unknown>)['messages'] as Record<string, unknown>[];
    delete messages[0]['id'];
    expect(() => validateInbound(payload)).toThrow(ValidationError);
  });

  it('throws ValidationError for missing messages[0].from', () => {
    const payload = makeWebhookPayload();
    const messages = (payload.entry[0].changes[0].value as Record<string, unknown>)['messages'] as Record<string, unknown>[];
    delete messages[0]['from'];
    expect(() => validateInbound(payload)).toThrow(ValidationError);
  });

  it('throws ValidationError for non-object root', () => {
    expect(() => validateInbound('not an object')).toThrow(ValidationError);
  });

  it('throws ValidationError for wrong field value', () => {
    const payload = makeWebhookPayload();
    (payload.entry[0].changes[0] as Record<string, unknown>)['field'] = 'not_messages';
    expect(() => validateInbound(payload)).toThrow(ValidationError);
  });
});

describe('isE164', () => {
  it('valid E.164 numbers', () => {
    expect(isE164('+15551234567')).toBe(true);
    expect(isE164('+919876543210')).toBe(true);
    expect(isE164('+447700900123')).toBe(true);
  });

  it('missing + prefix', () => {
    expect(isE164('15551234567')).toBe(false);
    expect(isE164('919876543210')).toBe(false);
  });

  it('too short', () => {
    expect(isE164('+1234567')).toBe(false);
    expect(isE164('+123')).toBe(false);
  });

  it('too long', () => {
    expect(isE164('+123456789012345678')).toBe(false);
  });

  it('leading zero after +', () => {
    expect(isE164('+0123456789')).toBe(false);
  });
});

describe('validateOutbound', () => {
  const validBody = {
    recipient: '+15551234567',
    text: 'Hello there',
    correlationId: 'corr-123',
  };

  it('happy path', () => {
    const result = validateOutbound(validBody);
    expect(result.recipient).toBe('+15551234567');
    expect(result.text).toBe('Hello there');
    expect(result.correlationId).toBe('corr-123');
  });

  it('throws MISSING_FIELD for missing recipient', () => {
    expect(() => validateOutbound({ text: 'Hello', correlationId: 'c1' })).toThrow(ValidationError);
    try {
      validateOutbound({ text: 'Hello', correlationId: 'c1' });
    } catch (err) {
      expect((err as ValidationError).code).toBe('MISSING_FIELD');
      expect((err as ValidationError).field).toBe('recipient');
    }
  });

  it('throws INVALID_FORMAT for non-E.164 recipient', () => {
    expect(() => validateOutbound({ recipient: '15551234567', text: 'Hello', correlationId: 'c1' })).toThrow(ValidationError);
    try {
      validateOutbound({ recipient: '15551234567', text: 'Hello', correlationId: 'c1' });
    } catch (err) {
      expect((err as ValidationError).code).toBe('INVALID_FORMAT');
    }
  });

  it('throws MISSING_FIELD for empty text', () => {
    expect(() => validateOutbound({ recipient: '+15551234567', text: '', correlationId: 'c1' })).toThrow(ValidationError);
  });

  it('throws INVALID_FORMAT for text > 4096 chars', () => {
    const longText = 'a'.repeat(4097);
    expect(() => validateOutbound({ recipient: '+15551234567', text: longText, correlationId: 'c1' })).toThrow(ValidationError);
    try {
      validateOutbound({ recipient: '+15551234567', text: longText, correlationId: 'c1' });
    } catch (err) {
      expect((err as ValidationError).code).toBe('INVALID_FORMAT');
    }
  });

  it('accepts text exactly 4096 chars', () => {
    const maxText = 'a'.repeat(4096);
    expect(() => validateOutbound({ recipient: '+15551234567', text: maxText, correlationId: 'c1' })).not.toThrow();
  });

  it('throws MISSING_FIELD for missing correlationId', () => {
    expect(() => validateOutbound({ recipient: '+15551234567', text: 'Hello' })).toThrow(ValidationError);
    try {
      validateOutbound({ recipient: '+15551234567', text: 'Hello' });
    } catch (err) {
      expect((err as ValidationError).code).toBe('MISSING_FIELD');
      expect((err as ValidationError).field).toBe('correlationId');
    }
  });
});
