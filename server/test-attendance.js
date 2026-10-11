/** Integration tests for Option B: attendance migration, per-person shifts, and attachment guardrails. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const dir = mkdtempSync(join(tmpdir(), 'shiftbridge-attendance-'));
const dbPath = join(dir, 'isolated.sqlite');
process.env.SHIFTBRIDGE_DB_PATH = dbPath;
process.env.SHIFTBRIDGE_STORAGE = 'sqlite';

const { getDB, initSchema, closeDB } = await import('./db.js');
const { seedDatabase } = await import('./seed.js');

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

test('migration preserves shifts; current state and history are per-person', { timeout: 30000 }, async () => {
  let child;
  try {
    initSchema();
    seedDatabase();
    const db = getDB();
    // Recreate exactly the former workspace-keyed shift table to exercise a real upgrade.
    db.exec(`
      DELETE FROM shift_sessions;
      DROP TABLE shifts;
      CREATE TABLE shifts(
        workspace_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        clocked_in INTEGER NOT NULL DEFAULT 0,
        since INTEGER,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      INSERT INTO shifts VALUES('daily','jack',1,1791683628215);
    `);
    initSchema();
    const keys = db.prepare('PRAGMA table_info(shifts)').all().filter(c => c.pk).map(c => c.name);
    assert.deepEqual(keys, ['workspace_id', 'person_id']);
    assert.equal(db.prepare("SELECT count(*) AS n FROM shift_sessions WHERE workspace_id='daily' AND person_id='jack' AND clock_out_at IS NULL").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name in ('message_attachments','shift_sessions')").get().n, 2);
    assert.throws(() => db.prepare(`INSERT INTO message_attachments(
      id, workspace_id, message_id, uploaded_by, storage_bucket, storage_path,
      original_name,content_type,size_bytes,created_at)
      VALUES('bad','daily','not-a-message','emma','shiftbridge-chat','bad/path',
        'bad.png','image/png',10,123)`).run(), /FOREIGN KEY/);
    closeDB();

    const port = await getAvailablePort();
    const origin = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, SHIFTBRIDGE_DB_PATH: dbPath, SHIFTBRIDGE_STORAGE: 'sqlite',
        GROQ_ENABLED: '0', PORT: String(port) },
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error('Backend terminated unexpectedly');
      try {
        const r = await fetch(origin + '/api/health');
        if (r.ok) { ready = true; break; }
      } catch { /* starting */ }
      await wait(100);
    }
    assert.ok(ready, 'Backend should become healthy');
    const get = async (path) => fetch(origin + path).then(r => r.json());
    const shift = (personId) => get('/api/workspaces/daily/shift?personId=' + personId);
    const toggle = async (personId) => {
      const res = await fetch(origin + '/api/workspaces/daily/shift', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId }),
      });
      assert.equal(res.status, 200);
      return res.json();
    };
    assert.equal((await shift('jack')).on, true);
    assert.equal((await shift('emma')).on, false);
    assert.equal((await toggle('emma')).on, true);
    assert.equal((await shift('jack')).on, true, 'Emma must not change Jack\'s state');
    assert.equal((await toggle('emma')).on, false);
    const history = await get('/api/workspaces/daily/shift-sessions?personId=emma');
    assert.equal(history.sessions.length, 1);
    assert.ok(history.sessions[0].clockOutAt >= history.sessions[0].clockInAt);
    const attachments = await get('/api/workspaces/daily/attachments');
    assert.deepEqual(attachments.attachments, []);
    const photoResponse = await fetch(origin + '/api/workspaces/daily/messages/m1/attachments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'emma' }),
    });
    assert.equal(photoResponse.status, 503, 'Uploads fail closed without Supabase');
    const badEmployee = await fetch(origin + '/api/workspaces/daily/shift', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personId: 'not-a-member' }),
    });
    assert.equal(badEmployee.status, 400);
  } finally {
    if (child) { child.kill('SIGTERM'); await wait(200); }
    closeDB();
    rmSync(dir, { recursive: true, force: true });
  }
});
