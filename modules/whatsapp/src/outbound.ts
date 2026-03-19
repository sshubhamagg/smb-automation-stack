import type { Config } from './config';

export interface OutboundResult {
  correlation_id: string;
  status: 'accepted' | 'failed' | 'throttled';
  provider_message_id?: string;
  error?: {
    code: string;
    message: string;
    provider_error_code?: number;
    retry_after_seconds?: number;
  };
}

export function buildRequestPayload(
  recipient: string,
  text: string,
  _phoneNumberId: string
): object {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: recipient,
    type: 'text',
    text: {
      preview_url: false,
      body: text,
    },
  };
}

export async function parseProviderResponse(
  response: Response,
  correlationId: string
): Promise<OutboundResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      correlation_id: correlationId,
      status: 'failed',
      error: {
        code: 'PROVIDER_ERROR',
        message: 'Failed to parse provider response as JSON',
      },
    };
  }

  if (response.status === 200 || response.status === 201) {
    const bodyObj = body as Record<string, unknown>;
    const messages = bodyObj['messages'];
    let providerMessageId: string | undefined;

    if (Array.isArray(messages) && messages.length > 0) {
      const firstMsg = messages[0] as Record<string, unknown>;
      if (typeof firstMsg['id'] === 'string') {
        providerMessageId = firstMsg['id'];
      }
    }

    return {
      correlation_id: correlationId,
      status: 'accepted',
      provider_message_id: providerMessageId,
    };
  }

  const bodyObj = body as Record<string, unknown>;
  const errorObj = bodyObj['error'] as Record<string, unknown> | undefined;
  const errorCode =
    errorObj && typeof errorObj['code'] === 'number' ? errorObj['code'] : undefined;
  const errorMessage =
    errorObj && typeof errorObj['message'] === 'string'
      ? errorObj['message']
      : `Provider returned HTTP ${response.status}`;

  return {
    correlation_id: correlationId,
    status: 'failed',
    error: {
      code: 'PROVIDER_ERROR',
      message: errorMessage,
      provider_error_code: errorCode,
    },
  };
}

export async function sendMessage(
  recipient: string,
  text: string,
  correlationId: string,
  config: Config
): Promise<OutboundResult> {
  const { whatsappPhoneNumberId, whatsappApiToken, outboundTimeoutSeconds } = config;
  const url = `https://graph.facebook.com/v19.0/${whatsappPhoneNumberId}/messages`;
  const payload = buildRequestPayload(recipient, text, whatsappPhoneNumberId);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, outboundTimeoutSeconds * 1000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${whatsappApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return parseProviderResponse(response, correlationId);
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === 'AbortError') {
      return {
        correlation_id: correlationId,
        status: 'failed',
        error: {
          code: 'PROVIDER_ERROR',
          message: 'Request timed out',
        },
      };
    }

    return {
      correlation_id: correlationId,
      status: 'failed',
      error: {
        code: 'PROVIDER_ERROR',
        message: err instanceof Error ? err.message : 'Network error',
      },
    };
  }
}
