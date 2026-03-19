import { google } from 'googleapis';
import { Config } from './config';

export type SheetResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; details?: Record<string, unknown> } };

type SheetsApi = ReturnType<typeof google.sheets>;

let sheetsApi: SheetsApi | null = null;

export function initClient(config: Config): void {
  const credentials = JSON.parse(config.serviceAccountJson) as {
    client_email: string;
    private_key: string;
  };

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  sheetsApi = google.sheets({ version: 'v4', auth });
}

export function resetClient(): void {
  sheetsApi = null;
}

function getClient(): SheetsApi {
  if (!sheetsApi) throw new Error('Sheets client not initialized. Call initClient() first.');
  return sheetsApi;
}

type ApiError = { code: string; message: string; details?: Record<string, unknown> };

function mapApiError(err: unknown, sheetId: string): ApiError {
  const e = err as { code?: number; message?: string };
  if (e.code === 404) {
    return { code: 'SHEET_NOT_FOUND', message: 'Sheet or range not found', details: { sheetId } };
  }
  if (e.code === 401 || e.code === 403) {
    return { code: 'AUTH_FAILED', message: 'Authentication failed' };
  }
  return { code: 'API_ERROR', message: e.message ?? 'Google Sheets API error' };
}

export async function getValues(sheetId: string, range: string): Promise<SheetResult<string[][]>> {
  try {
    const response = await getClient().spreadsheets.values.get({
      spreadsheetId: sheetId,
      range,
    });
    return { success: true, data: (response.data.values ?? []) as string[][] };
  } catch (err: unknown) {
    return { success: false, error: mapApiError(err, sheetId) };
  }
}

export async function appendValues(
  sheetId: string,
  range: string,
  row: string[]
): Promise<SheetResult<{ updatedRange: string }>> {
  try {
    const response = await getClient().spreadsheets.values.append({
      spreadsheetId: sheetId,
      range,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    const updatedRange = response.data.updates?.updatedRange ?? range;
    return { success: true, data: { updatedRange } };
  } catch (err: unknown) {
    return { success: false, error: mapApiError(err, sheetId) };
  }
}

export async function updateValues(
  sheetId: string,
  targetRange: string,
  row: string[]
): Promise<SheetResult<{ updatedRange: string }>> {
  try {
    const response = await getClient().spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: targetRange,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    const updatedRange = response.data.updatedRange ?? targetRange;
    return { success: true, data: { updatedRange } };
  } catch (err: unknown) {
    return { success: false, error: mapApiError(err, sheetId) };
  }
}
