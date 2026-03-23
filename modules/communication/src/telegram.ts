import axios from 'axios';
import type { CommunicationAdapter } from './types';

export class TelegramAdapter implements CommunicationAdapter {
  async send(to: string, message: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) throw new Error('Missing env: TELEGRAM_BOT_TOKEN');
    if (!to)    throw new Error('Missing Telegram chat ID');
    if (!message) throw new Error('Missing message body');

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    console.log('[TELEGRAM SEND]', { chatId: to, messageLength: message.length });

    let res: { data: { ok: boolean; description?: string } };
    try {
      res = await axios.post(url, { chat_id: to, text: message });
    } catch (err) {
      if (axios.isAxiosError(err) && err.response) {
        const body = err.response.data as { description?: string };
        throw new Error(`Telegram API error ${err.response.status}: ${body?.description ?? err.message}`);
      }
      throw new Error(`Telegram network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.data.ok) {
      throw new Error(`Telegram API error: ${res.data.description ?? 'unknown'}`);
    }

    console.log('[TELEGRAM SEND OK]', { chatId: to });
  }
}
