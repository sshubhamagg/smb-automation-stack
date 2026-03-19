import { loadConfig } from './config';
import { initClient } from './sheetsClient';
import { setLogLevel } from './logger';
import { handle } from './handler';

export interface ReadInput {
  sheetId: string;
  range?: string;
}

export interface AppendInput {
  sheetId: string;
  range: string;
  row: string[];
}

export interface UpdateInput {
  sheetId: string;
  range: string;
  rowIndex: number;
  row: string[];
}

export interface SearchInput {
  sheetId: string;
  range: string;
  filter: Record<string, string>;
}

function setup(): void {
  const config = loadConfig();
  setLogLevel(config.logLevel);
  initClient(config);
}

setup();

export async function read(input: ReadInput) {
  return handle('read', input);
}

export async function append(input: AppendInput) {
  return handle('append', input);
}

export async function update(input: UpdateInput) {
  return handle('update', input);
}

export async function search(input: SearchInput) {
  return handle('search', input);
}
