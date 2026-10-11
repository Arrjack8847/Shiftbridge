/** Integration tests: manager approval and disapproval across For Attention. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const dir = mkdtempSync(join(tmpdir(), 'shiftbridge-attention-'));
const dbPath = join(dir, 'review.sqlite');
process.env.SHIFTBRIDGE_DB_PATH = dbPath;
process.env.SHIFTBRIDGE_STORAGE = 'sqlite';
const { getDB, initSchema, closeDB } = await import('./db.js');
const { seedDatabase } = await import('./seed.js');

async function port() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('manager reviews are audited, scoped and never bypass safety verification', { timeout: 30000 }, async () => {
  let child;
  try {
    initSchema();
    seedDatabase();
    const d = getDB();
    const ts = Date.now();
    for (const [id, status, category, verification] of [
      ['att_normal', 'review', 'routine', 'self-report'],
      ['att_protected', 'review', 'safety', 'qualified'],
      ['att_blocked', 'blocked', 'repairs', 'qualified'],
    ]) {
      d.prepare('INSERT INTO tasks (id,workspace_id,name,status,category,verification,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, 'daily', id, status, category, verification, ts, ts);
    }
    d.prepare("INSERT INTO issues (id,workspace_id,title,status,issue_type,created_at) VALUES ('att_issue','daily','Safety concern','reported','safety',?)").run(ts);
    closeDB();

    const p = await port();
    const origin = 'http://127.0.0.1:' + p;
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: new URL('../', import.meta.url),
      env: { ...process.env, PORT: String(p), SHIFTBRIDGE_DB_PATH: dbPath,
        SHIFTBRIDGE_STORAGE: 'sqlite', GROQ_ENABLED: '0' },
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if (child.exitCode !== null) throw Error('Backend exited unexpectedly');
      try {
        const r = await fetch(origin + '/api/health');
        if (r.ok) { ready = true; break; }
      } catch { /* not started */ }
      await wait(100);
    }
    assert.ok(ready, 'Server starts');
    const review = async (type, id, body) => {
      const res = await fetch(origin + '/api/attention/' + type + '/' + id + '/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    };
    const get = async (path) => (await fetch(origin + path)).json();
    const manager = { reviewerId: 'manager' };

    assert.equal((await review('issue', 'att_issue', { ...manager, decision: 'approve' })).status, 200);
    let issue = await get('/api/issues/att_issue');
    assert.equal(issue.approved, true);
    assert.equal(issue.status, 'acknowledged', 'Approval authorizes follow-up, not clearance');
    assert.equal(issue.verifiedAt, null);
    assert.equal((await review('issue', 'att_issue', { reviewerId: 'jack', decision: 'disapprove', note: 'wrong' })).status, 403);
    assert.equal((await review('issue', 'att_issue', { ...manager, decision: 'disapprove' })).status, 400);
    assert.equal((await review('issue', 'att_issue', { ...manager, decision: 'disapprove', note: 'Further inspection required' })).status, 200);
    issue = await get('/api/issues/att_issue');
    assert.notEqual(issue.status, 'resolved', 'A disapproved safety request is still open');
    assert.equal(issue.approved, false);

    const pending = await get('/api/workspaces/daily/attention-decisions');
    const latest = pending.decisions.find(x => x.type === 'issue' && x.entityId === 'att_issue');
    assert.equal(latest.decision, 'disapprove');
    assert.equal(latest.note, 'Further inspection required');
    assert.equal(latest.reviewer, 'manager');

    const noProof = await review('task', 'att_protected', { ...manager, decision: 'approve' });
    assert.equal(noProof.status, 200);
    assert.equal(noProof.data.outcome, 'approved_pending_qualified_verification');
    assert.equal((await get('/api/tasks/att_protected')).status, 'review');
    assert.equal((await review('task','att_protected',{ ...manager, decision:'approve', verificationEvidence:'test report 24' })).status,400);
    const qualified = await review('task', 'att_protected', {
      ...manager, decision:'approve', qualifiedVerifier:'Qualified inspector',
      verificationEvidence:'Inspected machine and recorded passing test result / report 24',
    });
    assert.equal(qualified.status, 200);
    assert.equal((await get('/api/tasks/att_protected')).status, 'done');
    assert.equal((await review('task', 'att_protected', { ...manager, decision: 'approve' })).status, 409);

    assert.equal((await review('task','att_normal',{ ...manager,decision:'disapprove',note:'Redo the checklist' })).status, 200);
    const returned = await get('/api/tasks/att_normal');
    assert.equal(returned.status, 'doing');
    assert.match(returned.completion, /Redo the checklist/);
    const blocked = await review('task', 'att_blocked', { ...manager, decision:'approve', note:'Investigate first' });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.data.outcome, 'blocker_still_open');
    assert.equal((await get('/api/tasks/att_blocked')).status, 'blocked');

    const dbAudit = await get('/api/workspaces/daily/audit');
    assert.ok(dbAudit.audit.some(x => x.action === 'attention_reviewed' && x.entityId === 'att_issue'));
  } finally {
    if (child) { child.kill('SIGTERM'); await wait(200); }
    closeDB();
    rmSync(dir, { recursive: true, force: true });
  }
});
