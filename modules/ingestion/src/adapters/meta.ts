import { verifySignature, validateInbound, ValidationError } from '../../../whatsapp/src/validator';
import { normalize } from '../../../whatsapp/src/normalizer';
import type { Adapter, IngestionInput, IngestionResult, NormalizedEvent } from '../types';

export class MetaAdapter implements Adapter {
  async execute(input: IngestionInput): Promise<IngestionResult> {
    // Step 1: signature verification — opt-in, only runs when all three are supplied
    if (
      input.rawBody !== undefined &&
      input.headers !== undefined &&
      input.secret !== undefined
    ) {
      const sigHeader = input.headers['x-hub-signature-256'] ?? '';
      const valid = verifySignature(input.rawBody, sigHeader, input.secret);
      if (!valid) {
        return { ok: false, reason: 'signature_invalid' };
      }
    }

    // Step 2: validate the Meta webhook payload structure
    let validated: ReturnType<typeof validateInbound>;
    try {
      validated = validateInbound(input.payload);
    } catch (err) {
      if (err instanceof ValidationError) {
        return { ok: false, reason: 'validation_failed', error: err.message };
      }
      return { ok: false, reason: 'validation_failed', error: String(err) };
    }

    // Step 3: null means Meta sent a status-only event (no messages array)
    if (validated === null) {
      return { ok: false, reason: 'status_update' };
    }

    // Step 4: only text messages produce a usable event downstream
    if (validated.type !== 'text') {
      return { ok: false, reason: 'unsupported_type', type: validated.type };
    }

    // Step 5: normalize using the existing whatsapp normalizer
    const normalized = normalize(validated);

    // Step 6: map NormalizedMessage → NormalizedEvent
    const event: NormalizedEvent = {
      source: input.source,
      provider: input.provider,
      userId: normalized.phone_number,
      message: normalized.text_body,
      raw: input.payload,
      timestamp: Date.parse(normalized.timestamp),
      metadata: {
        messageId: normalized.message_id,
        correlationId: normalized.correlation_id,
        messageType: normalized.message_type,
        receivedAt: normalized.received_at,
        status: normalized.status,
        phoneNumberId: validated.phoneNumberId,
      },
    };

    return { ok: true, event };
  }
}
