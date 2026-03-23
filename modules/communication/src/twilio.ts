import type { CommunicationAdapter } from './types';

const fetch = global.fetch;

export class TwilioAdapter implements CommunicationAdapter {
  async send(phone: string, message: string): Promise<void> {
    const sid = process.env.TWILIO_ACCOUNT_SID!;
    const token = process.env.TWILIO_AUTH_TOKEN!;
    const from = process.env.TWILIO_WHATSAPP_NUMBER!;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

    const body = new URLSearchParams({
      From: from,
      To: phone,
      Body: message,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Twilio error: ${text}`);
    }
  }
}
