import type { CommunicationAdapter } from './types';

const fetch = global.fetch;

export class MetaAdapter implements CommunicationAdapter {
  async send(phone: string, message: string): Promise<void> {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

    if (!phoneNumberId) throw new Error('Missing env: WHATSAPP_PHONE_NUMBER_ID');
    if (!accessToken) throw new Error('Missing env: WHATSAPP_ACCESS_TOKEN');
    if (!phone) throw new Error('Missing recipient phone number');
    if (!message) throw new Error('Missing message body');

    const to = phone.replace(/^whatsapp:/, '').replace(/^\+/, '');
    const url = `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`;

    console.log('[META SEND]', { to, messageLength: message.length });

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: message },
        }),
      });
    } catch (err) {
      throw new Error(`Meta API network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json() as { error?: { message?: string; code?: number } };
        detail = body?.error?.message ?? (await res.text());
      } catch {
        detail = String(res.status);
      }
      throw new Error(`Meta API error ${res.status}: ${detail}`);
    }

    console.log('[META SEND OK]', { to });
  }
}
