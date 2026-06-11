/**
 * Thread attachments — on-disk storage + JSON sidecar index, no DB migration.
 * Shared by chat.ts (upload endpoint + prompt manifest) and
 * chat-directives.ts (import_brief reads an uploaded markdown file).
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';

export interface AttachmentEntry {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
}

export type AttachmentIndex = Record<string, AttachmentEntry>;

export function uploadDirFor(threadId: string): string {
  return path.join(env.WISP_DATA_DIR, 'uploads', threadId);
}

export function indexPathFor(threadId: string): string {
  return path.join(uploadDirFor(threadId), 'index.json');
}

/** Strip path separators / traversal so a filename can never escape the dir. */
export function sanitizeFilename(name: string): string {
  const base = name.replace(/[\\/]/g, '_').replace(/\.\.+/g, '_').trim();
  return base.length > 0 ? base.slice(0, 200) : 'file';
}

export async function readAttachmentIndex(threadId: string): Promise<AttachmentIndex> {
  try {
    const raw = await readFile(indexPathFor(threadId), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as AttachmentIndex) : {};
  } catch {
    return {};
  }
}

export async function writeAttachmentIndex(
  threadId: string,
  index: AttachmentIndex,
): Promise<void> {
  await writeFile(indexPathFor(threadId), JSON.stringify(index, null, 2), 'utf8');
}
