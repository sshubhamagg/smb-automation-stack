jest.mock('axios');

import axios from 'axios';
import { TelegramAdapter } from '../src/telegram';

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    adapter = new TelegramAdapter();
    process.env = { ...OLD_ENV, TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('sends a message successfully and resolves without error', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } });

    await expect(adapter.send('123456789', 'Hello from tests')).resolves.toBeUndefined();

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://api.telegram.org/bottest-bot-token/sendMessage',
      { chat_id: '123456789', text: 'Hello from tests' },
    );
  });

  it('throws when Telegram API returns ok:false', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: { ok: false, description: 'Bad Request: chat not found' },
    });

    await expect(adapter.send('000', 'hi')).rejects.toThrow(
      'Telegram API error: Bad Request: chat not found',
    );
  });

  it('throws when axios rejects with a response error', async () => {
    const axiosError = Object.assign(new Error('Request failed'), {
      isAxiosError: true,
      response: { status: 401, data: { description: 'Unauthorized' } },
    });
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(true);
    mockedAxios.post.mockRejectedValueOnce(axiosError);

    await expect(adapter.send('123', 'hi')).rejects.toThrow('Telegram API error 401: Unauthorized');
  });

  it('throws a network error when axios rejects without a response', async () => {
    const networkError = new Error('ECONNREFUSED');
    jest.spyOn(axios, 'isAxiosError').mockReturnValue(false);
    mockedAxios.post.mockRejectedValueOnce(networkError);

    await expect(adapter.send('123', 'hi')).rejects.toThrow('Telegram network error: ECONNREFUSED');
  });

  it('throws when TELEGRAM_BOT_TOKEN is missing', async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await expect(adapter.send('123', 'hi')).rejects.toThrow('Missing env: TELEGRAM_BOT_TOKEN');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('throws when chat ID is empty', async () => {
    await expect(adapter.send('', 'hi')).rejects.toThrow('Missing Telegram chat ID');
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
