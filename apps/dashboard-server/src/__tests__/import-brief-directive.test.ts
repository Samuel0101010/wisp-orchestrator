/**
 * Unit tests for the import_brief directive handler: an uploaded markdown
 * attachment becomes the project brief (docs/PRD.md verbatim + finalised
 * brief row), so a spec attached in the team chat reaches the build agents.
 */
import './setup.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeDirective } from '../routes/chat-directives.js';
import { uploadDirFor, writeAttachmentIndex } from '../routes/chat-attachments.js';
import { runMigrations } from '../db/migrate.js';
import { sqlite } from '../db/index.js';
import { seedAgents } from '../db/agents-seed.js';

function makeThreadAndManagerMessage(): { threadId: string; managerMessageId: string } {
  const threadId = crypto.randomUUID();
  const managerMessageId = crypto.randomUUID();
  const manager = sqlite
    .prepare<unknown[], { id: string }>(`SELECT id FROM agents WHERE seed_key = 'manager' LIMIT 1`)
    .get();
  if (!manager) throw new Error('manager seed not found');
  sqlite
    .prepare(
      `INSERT INTO agent_threads (id, agent_id, title, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)`,
    )
    .run(threadId, manager.id, Date.now(), Date.now());
  sqlite
    .prepare(
      `INSERT INTO agent_messages (id, thread_id, role, content, created_at) VALUES (?, ?, 'assistant', '', ?)`,
    )
    .run(managerMessageId, threadId, Date.now());
  return { threadId, managerMessageId };
}

function makeProject(): { projectId: string; repoPath: string } {
  const projectId = crypto.randomUUID();
  const repoPath = mkdtempSync(join(tmpdir(), 'import-brief-repo-'));
  sqlite
    .prepare(`INSERT INTO projects (id, name, goal, repo_path, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(projectId, 'ImportBriefTest', 'goal text', repoPath, Date.now());
  return { projectId, repoPath };
}

async function uploadAttachment(
  threadId: string,
  filename: string,
  content: string,
): Promise<void> {
  const dir = uploadDirFor(threadId);
  mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const storagePath = join(dir, `${id}-${filename}`);
  writeFileSync(storagePath, content, 'utf8');
  await writeAttachmentIndex(threadId, {
    [id]: { id, filename, mimeType: 'text/markdown', sizeBytes: content.length, storagePath },
  });
}

describe('executeDirective — import_brief', () => {
  beforeAll(() => {
    runMigrations();
    seedAgents();
  });

  afterAll(() => {
    sqlite.close();
  });

  it('writes the attachment verbatim to docs/PRD.md and finalises the brief', async () => {
    const { threadId, managerMessageId } = makeThreadAndManagerMessage();
    const { projectId, repoPath } = makeProject();
    const spec = '# Spec\n\nThe secret word is ZINNOBER-42.\n';
    await uploadAttachment(threadId, 'spec.md', spec);

    const result = await executeDirective(
      { kind: 'import_brief', projectId, filename: 'spec.md' },
      { threadId, managerMessageId },
    );

    expect(result.kind).toBe('import_brief');
    expect(result.status).toBe('ok');
    const r = result.result as { projectId: string; filename: string; prdPath: string | null };
    expect(r.projectId).toBe(projectId);
    expect(r.prdPath).toBe('docs/PRD.md');
    expect(readFileSync(join(repoPath, 'docs', 'PRD.md'), 'utf8')).toBe(spec);

    const brief = sqlite
      .prepare<
        unknown[],
        { brief_ready: number; completeness_score: number; prd_path: string | null }
      >(`SELECT brief_ready, completeness_score, prd_path FROM project_briefs WHERE project_id = ?`)
      .get(projectId);
    expect(brief?.brief_ready).toBe(1);
    expect(brief?.completeness_score).toBe(100);
    expect(brief?.prd_path).toBe('docs/PRD.md');
  });

  it('resolves the project from the most recent create_project action when projectId is omitted', async () => {
    const { threadId, managerMessageId } = makeThreadAndManagerMessage();
    const { projectId, repoPath } = makeProject();
    sqlite
      .prepare(
        `INSERT INTO chat_actions (id, thread_id, message_id, kind, payload_json, result_json, status, created_at)
         VALUES (?, ?, ?, 'create_project', '{}', ?, 'ok', ?)`,
      )
      .run(
        crypto.randomUUID(),
        threadId,
        managerMessageId,
        JSON.stringify({ projectId }),
        Date.now(),
      );
    await uploadAttachment(threadId, 'brief.md', '# From thread');

    const result = await executeDirective(
      { kind: 'import_brief', filename: 'brief.md' },
      { threadId, managerMessageId },
    );

    expect(result.status).toBe('ok');
    expect(existsSync(join(repoPath, 'docs', 'PRD.md'))).toBe(true);
  });

  it('fails with attachment_not_found when no upload matches the filename', async () => {
    const { threadId, managerMessageId } = makeThreadAndManagerMessage();
    const { projectId } = makeProject();

    const result = await executeDirective(
      { kind: 'import_brief', projectId, filename: 'missing.md' },
      { threadId, managerMessageId },
    );

    expect(result.status).toBe('failed');
    expect((result.result as { error: string }).error).toContain('attachment_not_found');
  });

  it('rejects non-text attachments', async () => {
    const { threadId, managerMessageId } = makeThreadAndManagerMessage();
    const { projectId } = makeProject();
    await uploadAttachment(threadId, 'logo.png', 'binarvish');

    const result = await executeDirective(
      { kind: 'import_brief', projectId, filename: 'logo.png' },
      { threadId, managerMessageId },
    );

    expect(result.status).toBe('failed');
    expect((result.result as { error: string }).error).toContain('attachment_not_markdown');
  });
});
