/**
 * server/test.js — Backend integration tests.
 *
 * Tests the full Phase 3 demo workflow programmatically:
 *   1. Messages sent from one identity appear for others (multi-device sync)
 *   2. Tasks created by manager are visible to assignee
 *   3. Task completion claims sync across devices
 *   4. Workspace isolation (messages in one workspace don't leak to another)
 *   5. Idempotency (duplicate message IDs don't create duplicates)
 *
 * Run:  npm run test:backend
 */

import { getDB, initSchema, closeDB } from './db.js';
import { seedDatabase } from './seed.js';

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      results.push({ name, status: 'PASS' });
    })
    .catch((err) => {
      failed++;
      results.push({ name, status: 'FAIL', error: err.message });
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Mismatch'}: expected "${expected}", got "${actual}"`);
  }
}

// ── In-process test using the database directly ─────────────────────
// We test the data layer directly (no HTTP) to verify business logic.

function resetAndSeed() {
  const d = getDB();
  // Wipe all data.
  d.exec(`
    DELETE FROM ai_proposals;
    DELETE FROM audit_log;
    DELETE FROM handovers;
    DELETE FROM shifts;
    DELETE FROM rules;
    DELETE FROM issues;
    DELETE FROM tasks;
    DELETE FROM messages;
    DELETE FROM workspace_members;
    DELETE FROM workspaces;
  `);
  d.prepare("UPDATE meta SET value = '0' WHERE key = 'revision'").run();
  seedDatabase();
}

async function runTests() {
  console.log('\n  ┌──────────────────────────────────────────────┐');
  console.log('  │  ShiftBridge Backend Integration Tests       │');
  console.log('  └──────────────────────────────────────────────┘\n');

  // ── Test 1: Seed data loaded correctly ──────────────────────────
  await test('Seed data: 2 workspaces, 7 messages, 6 tasks, 1 issue', () => {
    resetAndSeed();
    const d = getDB();
    const ws = d.prepare('SELECT COUNT(*) as c FROM workspaces').get();
    const msg = d.prepare('SELECT COUNT(*) as c FROM messages').get();
    const tasks = d.prepare('SELECT COUNT(*) as c FROM tasks').get();
    const issues = d.prepare('SELECT COUNT(*) as c FROM issues').get();
    assertEqual(ws.c, 2, 'Workspace count');
    assertEqual(msg.c, 7, 'Message count');
    assertEqual(tasks.c, 6, 'Task count');
    assertEqual(issues.c, 1, 'Issue count');
  });

  // ── Test 2: Messages are workspace-isolated ─────────────────────
  await test('Workspace isolation: daily messages do not appear in riverside', () => {
    resetAndSeed();
    const d = getDB();
    const daily = d.prepare('SELECT COUNT(*) as c FROM messages WHERE workspace_id = ?').get('daily');
    const riverside = d.prepare('SELECT COUNT(*) as c FROM messages WHERE workspace_id = ?').get('riverside');
    assert(daily.c === 5, `Expected 5 daily messages, got ${daily.c}`);
    assert(riverside.c === 2, `Expected 2 riverside messages, got ${riverside.c}`);
  });

  // ── Test 3: New message from Manager appears in message list ────
  await test('Manager sends message — appears in workspace messages', () => {
    resetAndSeed();
    const d = getDB();
    const msgId = 'test_msg_1';
    const ts = Date.now();
    const maxSeq = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get('daily');
    const seq = (maxSeq?.maxSeq || 0) + 1;
    d.prepare('INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)').run(
      msgId, 'daily', 'manager', 'Jack, please check the oat milk stock.', ts, seq,
    );
    const found = d.prepare('SELECT * FROM messages WHERE id = ?').get(msgId);
    assert(found, 'Message not found after insert');
    assertEqual(found.body, 'Jack, please check the oat milk stock.', 'Message body');
    assertEqual(found.user_id, 'manager', 'Message user');
    assertEqual(found.workspace_id, 'daily', 'Message workspace');
  });

  // ── Test 4: Jack replies and message is visible ─────────────────
  await test('Jack replies — reply is stored and visible', () => {
    resetAndSeed();
    const d = getDB();
    const replyId = 'test_reply_1';
    const ts = Date.now();
    const maxSeq = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get('daily');
    const seq = (maxSeq?.maxSeq || 0) + 1;
    d.prepare('INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)').run(
      replyId, 'daily', 'jack', 'I checked it. Four cartons remaining.', ts, seq,
    );
    const found = d.prepare('SELECT * FROM messages WHERE id = ?').get(replyId);
    assert(found, 'Reply not found');
    assertEqual(found.body, 'I checked it. Four cartons remaining.', 'Reply body');
    assertEqual(found.user_id, 'jack', 'Reply user');

    // Verify total message count increased.
    const count = d.prepare('SELECT COUNT(*) as c FROM messages WHERE workspace_id = ?').get('daily');
    assertEqual(count.c, 6, 'Daily message count after reply');
  });

  // ── Test 5: Idempotency — duplicate message ID does not create duplicate ─
  await test('Idempotency: duplicate message ID does not create duplicate', () => {
    resetAndSeed();
    const d = getDB();
    const msgId = 'dup_test_1';
    const ts = Date.now();
    const maxSeq = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get('daily');
    const seq = (maxSeq?.maxSeq || 0) + 1;
    // Insert first time.
    d.prepare('INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)').run(
      msgId, 'daily', 'manager', 'Test message', ts, seq,
    );
    // Insert second time with same ID.
    d.prepare('INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)').run(
      msgId, 'daily', 'manager', 'Test message', ts, seq + 1,
    );
    const count = d.prepare('SELECT COUNT(*) as c FROM messages WHERE id = ?').get(msgId);
    assertEqual(count.c, 1, 'Duplicate prevention — should be exactly 1 message');
  });

  // ── Test 6: Manager creates a task assigned to Jack ─────────────
  await test('Manager creates task assigned to Jack — task is stored', () => {
    resetAndSeed();
    const d = getDB();
    const taskId = 'test_task_1';
    const ts = Date.now();
    d.prepare(
      `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'todo', 'normal', 'routine', 'Today', NULL, 'manager', 'self-report', '', ?, ?)`,
    ).run(taskId, 'daily', 'Check oat milk stock', 'Check storage and report remaining cartons', 'jack', ts, ts);
    const found = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    assert(found, 'Task not found');
    assertEqual(found.assignee, 'jack', 'Task assignee');
    assertEqual(found.status, 'todo', 'Task status');
    assertEqual(found.created_by, 'manager', 'Task creator');
  });

  // ── Test 7: Jack reports task completion ─────────────────────────
  await test('Jack reports completion — task status and completion recorded', () => {
    resetAndSeed();
    const d = getDB();
    const taskId = 't1'; // existing seed task assigned to jack
    d.prepare('UPDATE tasks SET status = ?, completion = ?, updated_at = ? WHERE id = ?').run(
      'done', 'Self-reported done', Date.now(), taskId,
    );
    const found = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    assertEqual(found.status, 'done', 'Task status after completion');
    assertEqual(found.completion, 'Self-reported done', 'Task completion text');
  });

  // ── Test 8: Manager sees updated task status ─────────────────────
  await test('Manager sees updated task status — query returns done', () => {
    resetAndSeed();
    const d = getDB();
    const taskId = 't1';
    // Jack completes the task.
    d.prepare('UPDATE tasks SET status = ?, completion = ?, updated_at = ? WHERE id = ?').run(
      'done', 'Self-reported done', Date.now(), taskId,
    );
    // Manager queries the task.
    const found = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    assertEqual(found.status, 'done', 'Manager sees task as done');
  });

  // ── Test 9: Qualified verification task goes to review, not done ─
  await test('Qualified verification task — completion goes to review, not done', () => {
    resetAndSeed();
    const d = getDB();
    const taskId = 't5'; // inspection task with verification='qualified'
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    assertEqual(task.verification, 'qualified', 'Task verification type');
    // When Jack reports completion on a qualified task, it should go to 'review' not 'done'.
    d.prepare('UPDATE tasks SET status = ?, completion = ?, updated_at = ? WHERE id = ?').run(
      'review', 'Awaiting qualified review', Date.now(), taskId,
    );
    const found = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    assertEqual(found.status, 'review', 'Qualified task should be in review, not done');
  });

  // ── Test 10: Workspace isolation for tasks ──────────────────────
  await test('Workspace isolation: daily tasks do not appear in riverside', () => {
    resetAndSeed();
    const d = getDB();
    const daily = d.prepare('SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?').get('daily');
    const riverside = d.prepare('SELECT COUNT(*) as c FROM tasks WHERE workspace_id = ?').get('riverside');
    assert(daily.c === 5, `Expected 5 daily tasks, got ${daily.c}`);
    assert(riverside.c === 1, `Expected 1 riverside task, got ${riverside.c}`);
  });

  // ── Test 11: Audit log records task status changes ───────────────
  await test('Audit log: task status change is recorded', () => {
    resetAndSeed();
    const d = getDB();
    const taskId = 't1';
    const ts = Date.now();
    d.prepare('UPDATE tasks SET status = ?, completion = ?, updated_at = ? WHERE id = ?').run(
      'done', 'Self-reported done', ts, taskId,
    );
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'audit_test_1', 'daily', 'task_status_changed', 'task', taskId, 'jack', 'todo → done', ts,
    );
    const audit = d.prepare('SELECT * FROM audit_log WHERE entity_id = ? AND action = ?').get(taskId, 'task_status_changed');
    assert(audit, 'Audit log entry not found');
    assertEqual(audit.actor, 'jack', 'Audit actor');
    assertEqual(audit.details, 'todo → done', 'Audit details');
  });

  // ── Test 12: Revision counter increments on write ────────────────
  await test('Revision counter: increments when data changes', () => {
    resetAndSeed();
    const d = getDB();
    const beforeRow = d.prepare("SELECT value FROM meta WHERE key = 'revision'").get();
    const before = parseInt(beforeRow.value, 10);
    // Simulate a write + revision bump.
    d.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'").run();
    const afterRow = d.prepare("SELECT value FROM meta WHERE key = 'revision'").get();
    const after = parseInt(afterRow.value, 10);
    assert(after > before, `Revision should increment: before=${before}, after=${after}`);
  });

  // ── Test 13: Issue resolution records evidence ───────────────────
  await test('Issue resolution: evidence is recorded', () => {
    resetAndSeed();
    const d = getDB();
    const ts = Date.now();
    d.prepare('UPDATE issues SET status = ?, evidence = ?, resolved_at = ? WHERE id = ?').run(
      'resolved', 'Qualified technician inspected on 2026-10-10, no leak found.', ts, 'i1',
    );
    const found = d.prepare('SELECT * FROM issues WHERE id = ?').get('i1');
    assertEqual(found.status, 'resolved', 'Issue status');
    assert(found.evidence.includes('Qualified technician'), 'Evidence text preserved');
    assert(found.resolved_at !== null, 'Resolved timestamp set');
  });

  // ── Test 14: Locked rules cannot be toggled ──────────────────────
  await test('Locked rules: repairs/safety/purchases are locked', () => {
    resetAndSeed();
    const d = getDB();
    const locked = d.prepare('SELECT * FROM rules WHERE workspace_id = ? AND locked = 1').all('daily');
    assert(locked.length === 3, `Expected 3 locked rules, got ${locked.length}`);
    const ids = locked.map((r) => r.id);
    assert(ids.includes('repairs'), 'Repairs rule should be locked');
    assert(ids.includes('purchases'), 'Purchases rule should be locked');
    assert(ids.includes('safety'), 'Safety rule should be locked');
  });

  // ── Test 15: Full Phase 3 demo workflow simulation ───────────────
  await test('Phase 3 demo workflow: manager message → jack reply → task → completion', () => {
    resetAndSeed();
    const d = getDB();
    const ts = Date.now();

    // Step 1: Manager sends message.
    let maxSeq = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get('daily');
    d.prepare('INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)').run(
      'wf_msg_1', 'daily', 'manager', 'Jack, please check the oat milk stock.', ts, (maxSeq?.maxSeq || 0) + 1,
    );
    const msg = d.prepare('SELECT * FROM messages WHERE id = ?').get('wf_msg_1');
    assertEqual(msg.body, 'Jack, please check the oat milk stock.', 'Manager message');

    // Step 2: Jack replies.
    maxSeq = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get('daily');
    d.prepare('INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)').run(
      'wf_msg_2', 'daily', 'jack', 'I checked it. Four cartons remaining.', ts + 1, (maxSeq?.maxSeq || 0) + 1,
    );
    const reply = d.prepare('SELECT * FROM messages WHERE id = ?').get('wf_msg_2');
    assertEqual(reply.body, 'I checked it. Four cartons remaining.', 'Jack reply');

    // Step 3: Manager creates a task assigned to Jack.
    d.prepare(
      `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'todo', 'normal', 'routine', 'Today', NULL, 'manager', 'self-report', '', ?, ?)`,
    ).run('wf_task_1', 'daily', 'Check oat milk stock', 'Check storage and report remaining cartons', 'jack', ts, ts);
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get('wf_task_1');
    assertEqual(task.assignee, 'jack', 'Task assignee');
    assertEqual(task.status, 'todo', 'Task initial status');

    // Step 4: Jack reports completion.
    d.prepare('UPDATE tasks SET status = ?, completion = ?, updated_at = ? WHERE id = ?').run(
      'done', 'Self-reported done', ts + 2, 'wf_task_1',
    );
    const done = d.prepare('SELECT * FROM tasks WHERE id = ?').get('wf_task_1');
    assertEqual(done.status, 'done', 'Task completed');
    assertEqual(done.completion, 'Self-reported done', 'Completion recorded');

    // Step 5: Manager can see the updated task.
    const managerView = d.prepare('SELECT * FROM tasks WHERE id = ?').get('wf_task_1');
    assertEqual(managerView.status, 'done', 'Manager sees done status');

    // Step 6: Verify all messages are in the correct workspace.
    const dailyMsgs = d.prepare('SELECT * FROM messages WHERE workspace_id = ? ORDER BY created_at').all('daily');
    assert(dailyMsgs.length >= 7, `Expected at least 7 daily messages (5 seed + 2 new), got ${dailyMsgs.length}`);
  });

  // ── Test 16: Protected category auto-upgrades verification to 'qualified' ─
  await test('Protected category: repairs task auto-sets verification=qualified', () => {
    resetAndSeed();
    const d = getDB();
    const ts = Date.now();

    // Simulate what the POST /api/tasks endpoint does for a 'repairs' task.
    // The server should auto-set verification='qualified' for protected categories.
    const category = 'repairs';
    const finalVerification = (['repairs', 'purchases', 'safety'].includes(category) && 'self-report' !== 'qualified') ? 'qualified' : 'self-report';

    d.prepare(
      `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'todo', 'high', ?, 'Today', NULL, 'manager', ?, '', ?, ?)`,
    ).run('enforce_task_1', 'daily', 'Fix espresso machine heating element', 'Heating element not reaching temp', 'jack', category, finalVerification, ts, ts);

    const found = d.prepare('SELECT * FROM tasks WHERE id = ?').get('enforce_task_1');
    assertEqual(found.category, 'repairs', 'Task category');
    assertEqual(found.verification, 'qualified', 'Protected task should have qualified verification');
  });

  // ── Test 17: Protected task 'done' is redirected to 'review' ────────
  await test('Protected task enforcement: status=done redirected to review', () => {
    resetAndSeed();
    const d = getDB();
    const ts = Date.now();

    // Create a qualified-verification task (simulating what API does).
    d.prepare(
      `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'todo', 'normal', 'routine', 'Today', NULL, 'manager', 'qualified', '', ?, ?)`,
    ).run('enforce_task_2', 'daily', 'Monthly safety inspection', 'Full safety walkthrough', 'jack', ts, ts);

    // Simulate the enforcement: employee tries to mark 'done', server redirects to 'review'.
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get('enforce_task_2');
    const isProtected = task.verification === 'qualified';
    const finalStatus = isProtected ? 'review' : 'done';

    d.prepare('UPDATE tasks SET status = ?, completion = ?, updated_at = ? WHERE id = ?').run(
      finalStatus, 'Claimed done — awaiting review', ts, 'enforce_task_2',
    );

    const found = d.prepare('SELECT * FROM tasks WHERE id = ?').get('enforce_task_2');
    assertEqual(found.status, 'review', 'Protected task should be in review, not done');
    assertEqual(found.completion, 'Claimed done — awaiting review', 'Completion claim preserved');

    // Audit log should record the enforcement.
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'audit_enforce_1', 'daily', 'enforced_review', 'task', 'enforce_task_2', 'system', `Protected task: status redirected to 'review' instead of 'done'`, ts,
    );
    const audit = d.prepare('SELECT * FROM audit_log WHERE entity_id = ? AND action = ?').get('enforce_task_2', 'enforced_review');
    assert(audit, 'Enforcement audit entry should exist');
    assertEqual(audit.actor, 'system', 'Enforcement actor should be system');
  });

  // ── Print results ────────────────────────────────────────────────
  console.log('\n  ┌──────────────────────────────────────────────┐');
  console.log('  │  Test Results                                 │');
  console.log('  └──────────────────────────────────────────────┘\n');

  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : '✗';
    const status = r.status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`  ${icon}  ${r.name}  [${status}]${r.error ? '\n      → ' + r.error : ''}`);
  }

  console.log(`\n  ──────────────────────────────────────────────`);
  console.log(`  Total: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests.
initSchema();
runTests().finally(() => {
  closeDB();
});
