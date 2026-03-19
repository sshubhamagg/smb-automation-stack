import { randomUUID } from 'node:crypto';
import type { ValidatedInbound } from './validator';

export interface NormalizedMessage {
  message_id: string;
  correlation_id: string;
  phone_number: string;
  timestamp: string;
  message_type: 'text' | 'unsupported';
  text_body?: string;
  media_metadata?: Record<string, unknown>;
  status: 'received' | 'duplicate';
  received_at: string;
}

export function toE164(rawPhone: string): string {
  return '+' + rawPhone;
}

export function epochToIso(tsString: string): string {
  return new Date(Number(tsString) * 1000).toISOString();
}

export function mapMessageType(providerType: string): 'text' | 'unsupported' {
  if (providerType === 'text') return 'text';
  return 'unsupported';
}

export function normalize(payload: ValidatedInbound): NormalizedMessage {
  const messageType = mapMessageType(payload.type);
  const result: NormalizedMessage = {
    message_id: payload.messageId,
    correlation_id: randomUUID(),
    phone_number: toE164(payload.from),
    timestamp: epochToIso(payload.timestamp),
    message_type: messageType,
    status: 'received',
    received_at: new Date().toISOString(),
  };

  if (messageType === 'text' && payload.text) {
    result.text_body = payload.text.body;
  }

  if (messageType === 'unsupported' && payload.mediaFields) {
    result.media_metadata = payload.mediaFields;
  }

  return result;
}
