import type { ModuleResult } from 'shared-types';

export type { ModuleResult };

export type StorageInput = {
  provider: string;                         // e.g. 'sheets'
  operation: 'read' | 'write' | 'update' | 'query';
  resource: string;                         // sheetId for sheets, table name for SQL, etc.
  data?: any;                               // row data for write/update
  query?: Record<string, any>;             // filter conditions for query
  options?: Record<string, any>;           // provider-specific options (e.g. range, rowIndex)
};

// StorageResult extends ModuleResult — adds optional metadata on success.
// Structurally compatible with ModuleResult<T>.
export type StorageResult<T = any> =
  | { ok: true; output: T; metadata?: any }
  | { ok: false; reason?: string; error: string };

export interface StorageAdapter {
  execute(input: StorageInput): Promise<StorageResult>;
}
