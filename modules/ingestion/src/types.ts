export type IngestionInput = {
  source: string;       // e.g. 'whatsapp'
  provider: string;     // e.g. 'meta'
  payload: unknown;     // parsed JSON body (req.body)
  rawBody?: Buffer | string;          // raw bytes — required for sig verification
  headers?: Record<string, string>;   // e.g. { 'x-hub-signature-256': '...' }
  secret?: string;      // HMAC secret — required for sig verification
};

export type NormalizedEventMetadata = {
  messageId?: string;
  correlationId?: string;
  messageType?: string;
  receivedAt?: string;
  status?: string;
  phoneNumberId?: string;
  [key: string]: any;     // allow provider-specific extensions
};

export type NormalizedEvent = {
  source: string;
  provider: string;
  userId: string;         // E.164 phone number
  message?: string;       // text body; absent for non-text types
  raw: unknown;           // original IngestionInput.payload
  timestamp: number;      // epoch milliseconds
  metadata?: NormalizedEventMetadata;
};

export type IngestionResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; reason: 'signature_invalid' }
  | { ok: false; reason: 'validation_failed'; error: string }
  | { ok: false; reason: 'status_update' }
  | { ok: false; reason: 'unsupported_type'; type: string }
  | { ok: false; reason: 'adapter_error'; error: string };

export interface Adapter {
  execute(input: IngestionInput): Promise<IngestionResult>;
}
