import { initClient, getValues, appendValues, updateValues, resetClient } from '../src/sheetsClient';

// Factory uses jest.fn() inside — no outer variable references (avoids hoisting TDZ issue)
jest.mock('googleapis', () => ({
  google: {
    auth: {
      JWT: jest.fn().mockImplementation(() => ({})),
    },
    sheets: jest.fn().mockReturnValue({
      spreadsheets: {
        values: {
          get: jest.fn(),
          append: jest.fn(),
          update: jest.fn(),
        },
      },
    }),
  },
}));

const testConfig = {
  serviceAccountJson: JSON.stringify({
    client_email: 'test@project.iam.gserviceaccount.com',
    private_key: 'FAKE_KEY',
  }),
  logLevel: 'silent',
};

// Resolved after mock is registered — google.sheets() returns the same mocked instance
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockGet: jest.Mock, mockAppend: jest.Mock, mockUpdate: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { google } = jest.requireMock('googleapis') as any;
  const api = google.sheets();
  mockGet = api.spreadsheets.values.get as jest.Mock;
  mockAppend = api.spreadsheets.values.append as jest.Mock;
  mockUpdate = api.spreadsheets.values.update as jest.Mock;

  resetClient();
  initClient(testConfig);
});

describe('getValues', () => {
  it('returns success with values from API', async () => {
    mockGet.mockResolvedValueOnce({ data: { values: [['name', 'qty'], ['cement', '50']] } });

    const result = await getValues('sheet1', 'Sheet1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([['name', 'qty'], ['cement', '50']]);
    }
  });

  it('returns empty array when API returns no values', async () => {
    mockGet.mockResolvedValueOnce({ data: {} });

    const result = await getValues('sheet1', 'Sheet1');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it('returns SHEET_NOT_FOUND on 404', async () => {
    mockGet.mockRejectedValueOnce({ code: 404, message: 'Not found' });

    const result = await getValues('bad-id', 'Sheet1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('SHEET_NOT_FOUND');
  });

  it('returns AUTH_FAILED on 401', async () => {
    mockGet.mockRejectedValueOnce({ code: 401, message: 'Unauthorized' });

    const result = await getValues('sheet1', 'Sheet1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('AUTH_FAILED');
  });

  it('returns AUTH_FAILED on 403', async () => {
    mockGet.mockRejectedValueOnce({ code: 403, message: 'Forbidden' });

    const result = await getValues('sheet1', 'Sheet1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('AUTH_FAILED');
  });

  it('returns API_ERROR on unexpected error', async () => {
    mockGet.mockRejectedValueOnce({ message: 'Internal server error' });

    const result = await getValues('sheet1', 'Sheet1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('API_ERROR');
  });
});

describe('appendValues', () => {
  it('returns success with updatedRange', async () => {
    mockAppend.mockResolvedValueOnce({ data: { updates: { updatedRange: 'Sheet1!A4:B4' } } });

    const result = await appendValues('sheet1', 'Sheet1', ['cement', '50']);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.updatedRange).toBe('Sheet1!A4:B4');
  });

  it('falls back to input range when updatedRange is missing', async () => {
    mockAppend.mockResolvedValueOnce({ data: {} });

    const result = await appendValues('sheet1', 'Sheet1', ['cement', '50']);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.updatedRange).toBe('Sheet1');
  });

  it('returns SHEET_NOT_FOUND on 404', async () => {
    mockAppend.mockRejectedValueOnce({ code: 404 });

    const result = await appendValues('bad-id', 'Sheet1', ['cement']);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('SHEET_NOT_FOUND');
  });

  it('returns API_ERROR on unexpected error', async () => {
    mockAppend.mockRejectedValueOnce({ message: 'Service unavailable' });

    const result = await appendValues('sheet1', 'Sheet1', ['cement']);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('API_ERROR');
  });
});

describe('updateValues', () => {
  it('returns success with updatedRange', async () => {
    mockUpdate.mockResolvedValueOnce({ data: { updatedRange: 'Sheet1!A3:B3' } });

    const result = await updateValues('sheet1', 'Sheet1!A3', ['steel', '75']);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.updatedRange).toBe('Sheet1!A3:B3');
  });

  it('falls back to input range when updatedRange is missing', async () => {
    mockUpdate.mockResolvedValueOnce({ data: {} });

    const result = await updateValues('sheet1', 'Sheet1!A3', ['steel', '75']);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.updatedRange).toBe('Sheet1!A3');
  });

  it('returns AUTH_FAILED on 401', async () => {
    mockUpdate.mockRejectedValueOnce({ code: 401 });

    const result = await updateValues('sheet1', 'Sheet1!A3', ['steel']);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('AUTH_FAILED');
  });

  it('returns API_ERROR on unexpected error', async () => {
    mockUpdate.mockRejectedValueOnce({ message: 'Quota exceeded' });

    const result = await updateValues('sheet1', 'Sheet1!A3', ['steel']);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('API_ERROR');
  });
});
