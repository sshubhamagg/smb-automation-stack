export interface TransformReadResult {
  rows: Record<string, string>[] | string[][];
  rowCount: number;
  range: string;
  headerValid: boolean;
}

export interface TransformWriteResult {
  updatedRange: string;
  updatedRowCount: number;
}

export function isValidHeader(row: string[]): boolean {
  return row.length > 0 && row.every((cell) => typeof cell === 'string' && cell.trim() !== '');
}

export function mapRows(headers: string[], rows: string[][]): Record<string, string>[] {
  return rows.map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, i) => {
      obj[header] = row[i] ?? '';
    });
    return obj;
  });
}

export function transformRead(values: string[][], range: string): TransformReadResult {
  if (!values || values.length === 0) {
    return { rows: [], rowCount: 0, range, headerValid: false };
  }

  const [headerRow, ...dataRows] = values;

  if (!isValidHeader(headerRow)) {
    return { rows: dataRows, rowCount: dataRows.length, range, headerValid: false };
  }

  const rows = mapRows(headerRow, dataRows);
  return { rows, rowCount: rows.length, range, headerValid: true };
}

export function transformWrite(updatedRange: string): TransformWriteResult {
  return { updatedRange, updatedRowCount: 1 };
}
