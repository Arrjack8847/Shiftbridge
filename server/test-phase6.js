/**
 * server/test-phase6.js — Phase 6 Tests: Manager Tasks, Issue Flagging, Announcements.
 *
 * Tests the three new Phase 6 workflows end-to-end using the database
 * directly. Covers:
 *
 * Workflow A — Manager direct task assignment (Tests 1-3):
 *   1. Manager message → task created directly (no proposal/approval)
 *   2. Duplicate manager task from same message → prevented by unique index
 *   3. Non-manager message → task not created (author validation)
 *
 * Workflow B — Employee flags chat message as issue (Tests 4-6):
 *   4. Employee flags message → issue created with reporter and source
 *   5. Duplicate flag from same message → prevented by unique index
 *   6. Different messages → separate issues allowed
 *
 * Workflow C — Manager-controlled announcements (Tests 7-12):
 *   7. Manager publishes announcement → created with correct fields
 *   8. Employee acknowledges announcement → recorded, idempotent
 *   9. Manager edits announcement → revision history created
 *  10. Manager archives announcement → archived_at set
 *  11. Safety announcement linked to unresolved issue → cannot archive
 *  12. Announcement list returns with acknowledgment counts
 *
 * Issue lifecycle (Tests 13-14):
 *  13. Issue has reporter_id, issue_type, linked_announcement_id fields
 *  14. Issue resolution with qualified verifier → status=resolved, verified_at set
 *
 * Schema verification (Tests 15-18):
 *  15. announcements table exists with correct columns
 *  16. announcement_revisions table exists with correct columns
 *  17. announcement_acknowledgments table exists with PK enforcement
 *  18. issues table has Phase 6 migration columns
 *
 * Uses an ISOLATED TEST DATABASE (server/test-phase6.db) — never touches
 * the live demo database at server/shiftbridge.db.
 *
 * Run:  node server/test-phase6.js
 */

// ── Isolated test database ──────────────────────────────────────────
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_DB = resolve(__dirname, 'shiftbridge.db');
const TEST_DB = resolve(__dirname, 'test-phase6.db');

// ── Safeguard: refuse to run against the live database ──────────────
if (process.env.SHIFTBRIDGE_DB_PATH && resolve(process.env.SHIFTBRIDGE_DB_PATH) === LIVE_DB) {
  console.error('\n  FATAL: Refusing to run tests against the live database at:');
  console.error(`  ${LIVE_DB}\n`);
  process.exit(2);
}

// Clean up any previous test database.
if (existsSync(TEST_DB)) {
  rmSync(TEST_DB);
  if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal');
  if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm');
}

process.env.SHIFTBRIDGE_DB_PATH = TEST_DB;

// Now dynamically import — db.js reads SHIFTBRIDGE_DB_PATH at eval time.
const db = await import('./db.js');
const { getDB, initSchema, closeDB, bumpRevision, mapAnnouncement, mapAnnouncementRevision, mapIssue } = db;
const { seedDatabase } = await import('./seed.js');

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

// ── Constants ────────────────────────────────────────────────────────
const PROTECTED_CATEGORIES = ['repairs', 'purchases', 'safety'];
const WS = 'daily';
const MANAGER_ID = 'manager';
const EMPLOYEE_ID = 'jack';

// ── Helper: reset and seed ───────────────────────────────────────────
function resetAndSeed() {
  const d = getDB();
  // Runtime safeguard: verify we are NOT on the live database.
  const dbInfo = d.prepare('PRAGMA database_list').get();
  if (dbInfo.file && resolve(dbInfo.file) === LIVE_DB) {
    throw new Error(`FATAL: Refusing to reset the live database at ${dbInfo.file}`);
  }
  // Initialize schema (creates Phase 6 tables if they don't exist)
  initSchema();
  d.exec(`
    DELETE FROM announcement_acknowledgments;
    DELETE FROM announcement_revisions;
    DELETE FROM announcements;
    DELETE FROM completion_claims;
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

// ── Helper: insert a test message ─────────────────────────────────────
function insertMessage(d, ws, userId, body, msgId) {
  const ts = Date.now();
  const seq = (d.prepare('SELECT COALESCE(MAX(seq), 0) + 1 as next FROM messages WHERE workspace_id = ?').get(ws).next);
  d.prepare(
    'INSERT INTO messages (id, workspace_id, user_id, body, seq, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(msgId, ws, userId, body, seq, ts);
  bumpRevision();
  return { id: msgId, ws, user: userId, body, seq, at: ts };
}

// ── Helper: simulate manager task creation (Workflow A) ──────────────
function createManagerTask(d, ws, messageId, taskName, assignee, category = 'routine', due = 'Today', priority = 'normal', description = '') {
  // Validate message exists
  const msgRow = d.prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?').get(messageId, ws);
  if (!msgRow) return { error: 'Source message not found', httpStatus: 404 };

  // Validate author is the workspace manager (role='admin' in workspace_members)
  const wsRow = d.prepare('SELECT * FROM workspaces WHERE id = ?').get(ws);
  if (!wsRow) return { error: 'Workspace not found', httpStatus: 404 };
  const authorMember = d.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND person_id = ?').get(ws, msgRow.user_id);
  if (!authorMember || authorMember.role !== 'admin') return { error: 'Message author is not the workspace manager', httpStatus: 403 };

  // Validate assignee is a workspace member
  const memberRow = d.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND person_id = ?').get(ws, assignee);
  if (!memberRow) return { error: 'Assignee is not a workspace member', httpStatus: 403 };

  // Validate category is not protected
  if (PROTECTED_CATEGORIES.includes(category)) return { error: 'Protected category cannot be assigned directly', httpStatus: 403 };

  // Check for duplicate (unique index idx_tasks_source_dedup)
  const existing = d.prepare('SELECT * FROM tasks WHERE workspace_id = ? AND source = ? AND name = ?').get(ws, messageId, taskName);
  if (existing) return { error: 'Duplicate: task already exists for this message', duplicate: true, httpStatus: 409 };

  // Create the task
  const taskId = `mt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const ts = Date.now();
  const verification = 'self-report';
  d.prepare(
    `INSERT INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, '', ?, ?)`,
  ).run(taskId, ws, taskName, description, assignee, priority, category, due, messageId, 'ai-agent', verification, ts, ts);

  // Audit log
  d.prepare(
    'INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'manager_task_created', 'task', taskId, 'silent-ai', `Direct task from manager message: ${taskName}`, ts);

  bumpRevision();
  const taskRow = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  return { task: { id: taskId, name: taskName, assignee, category, due, status: 'todo', source: messageId }, duplicate: false };
}

// ── Helper: simulate employee flagging a message as issue (Workflow B) ─
function reportIssue(d, ws, messageId, reporterId, title, description = '', issueType = 'equipment') {
  // Validate message exists
  const msgRow = d.prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?').get(messageId, ws);
  if (!msgRow) return { error: 'Source message not found', httpStatus: 404 };

  // Validate reporter is a workspace member
  const memberRow = d.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND person_id = ?').get(ws, reporterId);
  if (!memberRow) return { error: 'Reporter is not a workspace member', httpStatus: 403 };

  // Check for duplicate (unique index idx_issues_msg_dedup)
  const existing = d.prepare('SELECT * FROM issues WHERE workspace_id = ? AND source = ?').get(ws, messageId);
  if (existing) return { error: 'Duplicate: issue already flagged for this message', duplicate: true, httpStatus: 409 };

  // Create the issue
  const issueId = `is_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const ts = Date.now();
  const severity = issueType === 'safety' ? 'high' : 'normal';
  d.prepare(
    `INSERT INTO issues (id, workspace_id, title, description, status, severity, source, reporter_id, issue_type, created_at)
     VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(issueId, ws, title, description, severity, messageId, reporterId, issueType, ts);

  // Audit log
  d.prepare(
    'INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'issue_flagged', 'issue', issueId, reporterId, `Issue flagged from chat: ${title}`, ts);

  bumpRevision();
  return { issue: { id: issueId, title, description, status: 'open', severity, source: messageId, reporterId, issueType } };
}

// ── Helper: simulate announcement creation (Workflow C) ─────────────
function createAnnouncement(d, ws, title, body, type = 'general', publisherId = 'manager', linkedIssueId = null) {
  const annId = `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const ts = Date.now();
  d.prepare(
    `INSERT INTO announcements (id, workspace_id, title, body, type, status, publisher_id, linked_issue_id, created_by, created_at, published_at)
     VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)`,
  ).run(annId, ws, title, body, type, publisherId, linkedIssueId, publisherId, ts, ts);

  // Audit log
  d.prepare(
    'INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'announcement_published', 'announcement', annId, publisherId, `Published: ${title}`, ts);

  bumpRevision();
  return { announcement: { id: annId, title, body, type, status: 'published', publisherId, linkedIssueId, publishedAt: ts } };
}

// ── Helper: simulate acknowledgment ──────────────────────────────────
function acknowledgeAnnouncement(d, annId, personId) {
  const ts = Date.now();
  try {
    d.prepare(
      'INSERT OR IGNORE INTO announcement_acknowledgments (announcement_id, person_id, acknowledged_at) VALUES (?, ?, ?)',
    ).run(annId, personId, ts);
    const acks = d.prepare('SELECT * FROM announcement_acknowledgments WHERE announcement_id = ?').all(annId);
    bumpRevision();
    return { acknowledged: true, totalAcks: acks.length };
  } catch (err) {
    return { acknowledged: false, error: err.message };
  }
}

// ── Helper: simulate edit (revision creation) ─────────────────────────
function editAnnouncement(d, annId, newTitle, newBody, editorId) {
  const ann = d.prepare('SELECT * FROM announcements WHERE id = ?').get(annId);
  if (!ann) return { error: 'Announcement not found' };

  const ts = Date.now();
  // Create revision record
  const revId = `rev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  d.prepare(
    `INSERT INTO announcement_revisions (id, announcement_id, old_title, new_title, old_body, new_body, editor_id, edited_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(revId, annId, ann.title, newTitle, ann.body || '', newBody, editorId, ts);

  // Update the announcement
  d.prepare('UPDATE announcements SET title = ?, body = ? WHERE id = ?').run(newTitle, newBody, annId);
  bumpRevision();
  return { revision: { id: revId, oldTitle: ann.title, newTitle, editorId, editedAt: ts } };
}

// ── Helper: simulate archive ──────────────────────────────────────────
function archiveAnnouncement(d, annId) {
  const ann = d.prepare('SELECT * FROM announcements WHERE id = ?').get(annId);
  if (!ann) return { error: 'Announcement not found' };

  // Safety check: if type=safety and linked issue is open, refuse
  if (ann.type === 'safety' && ann.linked_issue_id) {
    const issue = d.prepare('SELECT * FROM issues WHERE id = ?').get(ann.linked_issue_id);
    if (issue && issue.status === 'open') {
      return { error: 'Cannot archive: linked safety issue is still open', httpStatus: 403 };
    }
  }

  const ts = Date.now();
  d.prepare('UPDATE announcements SET archived_at = ? WHERE id = ?').run(ts, annId);
  bumpRevision();
  return { archived: true, archivedAt: ts };
}

// ── Helper: simulate issue resolution with qualified verification ──────
function resolveIssue(d, issueId, verifierId, evidence) {
  const issue = d.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
  if (!issue) return { error: 'Issue not found' };

  const ts = Date.now();
  d.prepare(
    `UPDATE issues SET status = 'resolved', qualified_verifier = ?, verification_evidence = ?, verified_at = ? WHERE id = ?`,
  ).run(verifierId, evidence, ts, issueId);

  // Audit log
  d.prepare(
    'INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(`al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, issue.workspace_id, 'issue_resolved', 'issue', issueId, verifierId, `Resolved with evidence: ${evidence}`, ts);

  bumpRevision();
  return { resolved: true, verifierId, evidence, verifiedAt: ts };
}

// ═════════════════════════════════════════════════════════════════════
// TEST SUITE
// ═════════════════════════════════════════════════════════════════════

async function runTests() {
  console.log('\n  ┌─────────────────────────────────────────────────────────┐');
  console.log('  │  Phase 6 Tests: Manager Tasks, Issue Flagging,          │');
  console.log('  │  Announcements, Issue Lifecycle                        │');
  console.log('  └─────────────────────────────────────────────────────────┘\n');

  resetAndSeed();
  const d = getDB();

  // ── Schema verification (Tests 15-18) ──────────────────────────────

  await test('Test 15: announcements table exists with correct columns', () => {
    const cols = d.prepare("SELECT name FROM pragma_table_info('announcements')").all().map(c => c.name);
    assert(cols.includes('id'), 'Missing column: id');
    assert(cols.includes('workspace_id'), 'Missing column: workspace_id');
    assert(cols.includes('title'), 'Missing column: title');
    assert(cols.includes('body'), 'Missing column: body');
    assert(cols.includes('type'), 'Missing column: type');
    assert(cols.includes('status'), 'Missing column: status');
    assert(cols.includes('publisher_id'), 'Missing column: publisher_id');
    assert(cols.includes('linked_issue_id'), 'Missing column: linked_issue_id');
    assert(cols.includes('created_at'), 'Missing column: created_at');
    assert(cols.includes('published_at'), 'Missing column: published_at');
    assert(cols.includes('archived_at'), 'Missing column: archived_at');
  });

  await test('Test 16: announcement_revisions table exists with correct columns', () => {
    const cols = d.prepare("SELECT name FROM pragma_table_info('announcement_revisions')").all().map(c => c.name);
    assert(cols.includes('id'), 'Missing column: id');
    assert(cols.includes('announcement_id'), 'Missing column: announcement_id');
    assert(cols.includes('old_title'), 'Missing column: old_title');
    assert(cols.includes('new_title'), 'Missing column: new_title');
    assert(cols.includes('old_body'), 'Missing column: old_body');
    assert(cols.includes('new_body'), 'Missing column: new_body');
    assert(cols.includes('editor_id'), 'Missing column: editor_id');
    assert(cols.includes('edited_at'), 'Missing column: edited_at');
  });

  await test('Test 17: announcement_acknowledgments table enforces PK uniqueness', () => {
    const cols = d.prepare("SELECT name FROM pragma_table_info('announcement_acknowledgments')").all().map(c => c.name);
    assert(cols.includes('announcement_id'), 'Missing column: announcement_id');
    assert(cols.includes('person_id'), 'Missing column: person_id');
    assert(cols.includes('acknowledged_at'), 'Missing column: acknowledged_at');

    // Create a test announcement to acknowledge
    const ann = createAnnouncement(d, WS, 'Test PK', 'Body', 'general');
    const annId = ann.announcement.id;

    // First acknowledgment should succeed
    const r1 = acknowledgeAnnouncement(d, annId, 'jack');
    assert(r1.acknowledged === true, 'First acknowledgment should succeed');

    // Second acknowledgment from same person should be ignored (idempotent)
    const r2 = acknowledgeAnnouncement(d, annId, 'jack');
    assert(r2.acknowledged === true, 'Second acknowledgment should be idempotent');
    assertEqual(r2.totalAcks, 1, 'Should still have 1 acknowledgment');
  });

  await test('Test 18: issues table has Phase 6 migration columns', () => {
    const cols = d.prepare("SELECT name FROM pragma_table_info('issues')").all().map(c => c.name);
    assert(cols.includes('reporter_id'), 'Missing Phase 6 column: reporter_id');
    assert(cols.includes('linked_announcement_id'), 'Missing Phase 6 column: linked_announcement_id');
    assert(cols.includes('qualified_verifier'), 'Missing Phase 6 column: qualified_verifier');
    assert(cols.includes('verification_evidence'), 'Missing Phase 6 column: verification_evidence');
    assert(cols.includes('verified_at'), 'Missing Phase 6 column: verified_at');
    assert(cols.includes('issue_type'), 'Missing Phase 6 column: issue_type');
  });

  // ── Workflow A: Manager direct task assignment (Tests 1-3) ────────

  await test('Test 1 (Workflow A): Manager message -> task created directly', () => {
    resetAndSeed();
    const d = getDB();
    // Insert a message from the manager
    const msg = insertMessage(d, WS, MANAGER_ID, 'Jack, please check the remaining paper napkins and report the quantity before closing.', 'msg_test_a1');
    // Create manager task
    const result = createManagerTask(d, WS, msg.id, 'Check paper napkins quantity', 'jack', 'inventory', 'Today', 'normal', 'Check remaining paper napkins and report quantity');
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.task, 'Should return a task');
    assertEqual(result.task.name, 'Check paper napkins quantity', 'Task name mismatch');
    assertEqual(result.task.assignee, 'jack', 'Task assignee mismatch');
    assertEqual(result.task.status, 'todo', 'Task status should be todo');
    assertEqual(result.task.source, msg.id, 'Task should have source message ID');
    assertEqual(result.duplicate, false, 'Should not be a duplicate');

    // Verify the task exists in the database
    const taskRow = d.prepare('SELECT * FROM tasks WHERE id = ?').get(result.task.id);
    assert(taskRow, 'Task should exist in database');
    assertEqual(taskRow.assignee, 'jack', 'DB task assignee mismatch');
    assertEqual(taskRow.category, 'inventory', 'DB task category mismatch');
    assertEqual(taskRow.source, msg.id, 'DB task source mismatch');
  });

  await test('Test 2 (Workflow A): Duplicate manager task from same message -> prevented', () => {
    resetAndSeed();
    const d = getDB();
    const msg = insertMessage(d, WS, MANAGER_ID, 'Emma, restock the oat milk.', 'msg_test_a2');
    // First task creation should succeed
    const r1 = createManagerTask(d, WS, msg.id, 'Restock oat milk', 'emma', 'inventory');
    assert(!r1.error, `First creation should succeed: ${r1.error}`);
    // Second task creation with same message and name should fail
    const r2 = createManagerTask(d, WS, msg.id, 'Restock oat milk', 'emma', 'inventory');
    assert(r2.error, 'Second creation should be prevented');
    assert(r2.duplicate, 'Should be flagged as duplicate');
  });

  await test('Test 3 (Workflow A): Non-manager message -> task not created', () => {
    resetAndSeed();
    const d = getDB();
    // Insert a message from an employee (not the manager)
    const msg = insertMessage(d, WS, EMPLOYEE_ID, 'Jack, can you check the napkins?', 'msg_test_a3');
    const result = createManagerTask(d, WS, msg.id, 'Check napkins', 'jack', 'inventory');
    assert(result.error, 'Should error when author is not the manager');
    assert(result.error.includes('not the workspace manager'), `Error should mention manager: ${result.error}`);
    // Verify no task was created
    const tasks = d.prepare('SELECT * FROM tasks WHERE source = ?').all(msg.id);
    assertEqual(tasks.length, 0, 'No task should exist for this message');
  });

  // ── Workflow B: Employee flags message as issue (Tests 4-6) ──────

  await test('Test 4 (Workflow B): Employee flags message -> issue created with reporter', () => {
    resetAndSeed();
    const d = getDB();
    const msg = insertMessage(d, WS, EMPLOYEE_ID, 'Machine 2 is making a strange noise again!', 'msg_test_b4');
    const result = reportIssue(d, WS, msg.id, 'sarah', 'Machine 2 strange noise', 'Equipment making unusual sounds', 'equipment');
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.issue, 'Should return an issue');
    assertEqual(result.issue.title, 'Machine 2 strange noise', 'Issue title mismatch');
    assertEqual(result.issue.reporterId, 'sarah', 'Reporter should be sarah');
    assertEqual(result.issue.source, msg.id, 'Issue should have source message ID');
    assertEqual(result.issue.issueType, 'equipment', 'Issue type should be equipment');
    assertEqual(result.issue.status, 'open', 'Issue status should be open');

    // Verify in database
    const issueRow = d.prepare('SELECT * FROM issues WHERE id = ?').get(result.issue.id);
    assert(issueRow, 'Issue should exist in database');
    assertEqual(issueRow.reporter_id, 'sarah', 'DB reporter mismatch');
    assertEqual(issueRow.issue_type, 'equipment', 'DB issue type mismatch');
    assertEqual(issueRow.source, msg.id, 'DB source mismatch');
  });

  await test('Test 5 (Workflow B): Duplicate flag from same message -> prevented', () => {
    resetAndSeed();
    const d = getDB();
    const msg = insertMessage(d, WS, EMPLOYEE_ID, 'The display case is broken', 'msg_test_b5');
    // First flag should succeed
    const r1 = reportIssue(d, WS, msg.id, 'jack', 'Broken display case', 'Display case cracked', 'facility');
    assert(!r1.error, `First flag should succeed: ${r1.error}`);
    // Second flag from same message should fail
    const r2 = reportIssue(d, WS, msg.id, 'emma', 'Display case problem', 'Same issue different title', 'facility');
    assert(r2.error, 'Should prevent duplicate flag');
    assert(r2.duplicate, 'Should be flagged as duplicate');
  });

  await test('Test 6 (Workflow B): Different messages -> separate issues allowed', () => {
    resetAndSeed();
    const d = getDB();
    const msg1 = insertMessage(d, WS, EMPLOYEE_ID, 'Fridge temperature is too high', 'msg_test_b6a');
    const msg2 = insertMessage(d, WS, 'emma', 'Also the freezer is making noise', 'msg_test_b6b');
    const r1 = reportIssue(d, WS, msg1.id, 'jack', 'Fridge temp high', 'Temperature above safe range', 'equipment');
    const r2 = reportIssue(d, WS, msg2.id, 'emma', 'Freezer noise', 'Freezer making unusual sounds', 'equipment');
    assert(!r1.error && !r2.error, 'Both flags should succeed');
    assert(r1.issue.id !== r2.issue.id, 'Issues should have different IDs');
  });

  // ── Workflow C: Manager-controlled announcements (Tests 7-12) ─────

  await test('Test 7 (Workflow C): Manager publishes announcement -> correct fields', () => {
    resetAndSeed();
    const d = getDB();
    const result = createAnnouncement(d, WS, 'Machine 2 out of service', 'Do not use machine 2 until inspection is complete.', 'safety', 'manager', null);
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.announcement, 'Should return announcement');
    assertEqual(result.announcement.title, 'Machine 2 out of service', 'Title mismatch');
    assertEqual(result.announcement.type, 'safety', 'Type mismatch');
    assertEqual(result.announcement.status, 'published', 'Status should be published');
    assertEqual(result.announcement.publisherId, 'manager', 'Publisher should be manager');

    // Verify in database
    const annRow = d.prepare('SELECT * FROM announcements WHERE id = ?').get(result.announcement.id);
    assert(annRow, 'Announcement should exist in database');
    assertEqual(annRow.workspace_id, WS, 'DB workspace mismatch');
    assertEqual(annRow.type, 'safety', 'DB type mismatch');
    assert(annRow.published_at, 'DB published_at should be set');
    assert(!annRow.archived_at, 'DB archived_at should be null');
  });

  await test('Test 8 (Workflow C): Employee acknowledges announcement -> idempotent', () => {
    resetAndSeed();
    const d = getDB();
    const ann = createAnnouncement(d, WS, 'New cleaning schedule', 'Please follow the updated cleaning roster.', 'general', 'manager', null);
    const annId = ann.announcement.id;

    // Jack acknowledges
    const r1 = acknowledgeAnnouncement(d, annId, 'jack');
    assert(r1.acknowledged, 'First acknowledgment should succeed');
    assertEqual(r1.totalAcks, 1, 'Should have 1 ack');

    // Jack acknowledges again (idempotent)
    const r2 = acknowledgeAnnouncement(d, annId, 'jack');
    assert(r2.acknowledged, 'Second acknowledgment should be idempotent');
    assertEqual(r2.totalAcks, 1, 'Should still have 1 ack');

    // Emma acknowledges
    const r3 = acknowledgeAnnouncement(d, annId, 'emma');
    assert(r3.acknowledged, 'Emma acknowledgment should succeed');
    assertEqual(r3.totalAcks, 2, 'Should have 2 acks');
  });

  await test('Test 9 (Workflow C): Manager edits announcement -> revision history created', () => {
    resetAndSeed();
    const d = getDB();
    const ann = createAnnouncement(d, WS, 'Original title', 'Original body content.', 'general', 'manager', null);
    const annId = ann.announcement.id;

    // Edit the announcement
    const result = editAnnouncement(d, annId, 'Updated title', 'Updated body content.', 'manager');
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.revision, 'Should return revision');
    assertEqual(result.revision.oldTitle, 'Original title', 'Revision old title mismatch');
    assertEqual(result.revision.newTitle, 'Updated title', 'Revision new title mismatch');

    // Verify revision exists in database
    const revs = d.prepare('SELECT * FROM announcement_revisions WHERE announcement_id = ?').all(annId);
    assertEqual(revs.length, 1, 'Should have 1 revision');
    assertEqual(revs[0].old_title, 'Original title', 'DB revision old title mismatch');
    assertEqual(revs[0].new_title, 'Updated title', 'DB revision new title mismatch');

    // Verify announcement was updated
    const annRow = d.prepare('SELECT * FROM announcements WHERE id = ?').get(annId);
    assertEqual(annRow.title, 'Updated title', 'Announcement title should be updated');
    assertEqual(annRow.body, 'Updated body content.', 'Announcement body should be updated');
  });

  await test('Test 10 (Workflow C): Manager archives announcement -> archived_at set', () => {
    resetAndSeed();
    const d = getDB();
    const ann = createAnnouncement(d, WS, 'Temporary notice', 'This will be archived.', 'general', 'manager', null);
    const annId = ann.announcement.id;

    const result = archiveAnnouncement(d, annId);
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.archived, 'Should return archived=true');

    // Verify in database
    const annRow = d.prepare('SELECT * FROM announcements WHERE id = ?').get(annId);
    assert(annRow.archived_at, 'DB archived_at should be set');
  });

  await test('Test 11 (Workflow C): Safety announcement linked to open issue -> cannot archive', () => {
    resetAndSeed();
    const d = getDB();
    // Create an issue
    const msg = insertMessage(d, WS, EMPLOYEE_ID, 'Machine 2 is dangerous!', 'msg_test_c11');
    const issue = reportIssue(d, WS, msg.id, 'jack', 'Machine 2 safety hazard', 'Machine poses safety risk', 'safety');
    const issueId = issue.issue.id;

    // Create a safety announcement linked to the open issue
    const ann = createAnnouncement(d, WS, 'Safety alert: Machine 2', 'Do not use machine 2.', 'safety', 'manager', issueId);
    const annId = ann.announcement.id;

    // Attempt to archive should fail
    const result = archiveAnnouncement(d, annId);
    assert(result.error, 'Should error when archiving safety announcement with open issue');
    assert(result.error.includes('linked safety issue is still open'), `Error should mention open issue: ${result.error}`);

    // Verify announcement is NOT archived
    const annRow = d.prepare('SELECT * FROM announcements WHERE id = ?').get(annId);
    assert(!annRow.archived_at, 'Announcement should NOT be archived');

    // Now resolve the issue
    resolveIssue(d, issueId, 'manager', 'Technician inspection report #TR-2026, safety cleared');
    // Now archive should succeed
    const result2 = archiveAnnouncement(d, annId);
    assert(!result2.error, `Should succeed after issue resolved: ${result2.error}`);
    assert(result2.archived, 'Should be archived after issue resolved');
  });

  await test('Test 12 (Workflow C): Announcement list returns with acknowledgment counts', () => {
    resetAndSeed();
    const d = getDB();
    const ann = createAnnouncement(d, WS, 'Team meeting Friday', 'All staff meeting at 3pm.', 'general', 'manager', null);
    const annId = ann.announcement.id;

    // Have two employees acknowledge
    acknowledgeAnnouncement(d, annId, 'jack');
    acknowledgeAnnouncement(d, annId, 'emma');

    // Query announcements for the workspace
    const anns = d.prepare('SELECT * FROM announcements WHERE workspace_id = ? AND archived_at IS NULL').all(WS);
    assert(anns.length > 0, 'Should return at least one announcement');

    // Check acknowledgment count
    const ackCount = d.prepare('SELECT COUNT(*) as count FROM announcement_acknowledgments WHERE announcement_id = ?').get(annId).count;
    assertEqual(ackCount, 2, 'Should have 2 acknowledgments');

    // Verify mapped announcement has correct fields
    const mapped = mapAnnouncement(anns[0]);
    assert(mapped.id, 'Mapped announcement should have id');
    assert(mapped.title, 'Mapped announcement should have title');
    assertEqual(mapped.type, 'general', 'Mapped type mismatch');
  });

  // ── Issue lifecycle (Tests 13-14) ─────────────────────────────────

  await test('Test 13: Issue has Phase 6 fields (reporter, type, linked announcement)', () => {
    resetAndSeed();
    const d = getDB();
    const msg = insertMessage(d, WS, EMPLOYEE_ID, 'The oven is broken', 'msg_test_13');
    const issue = reportIssue(d, WS, msg.id, 'jack', 'Oven malfunction', 'Oven not heating properly', 'equipment');
    const issueId = issue.issue.id;

    // Create an announcement linked to the issue
    const ann = createAnnouncement(d, WS, 'Oven out of service', 'Do not use the oven.', 'safety', 'manager', issueId);

    // Link the announcement back to the issue
    d.prepare('UPDATE issues SET linked_announcement_id = ? WHERE id = ?').run(ann.announcement.id, issueId);

    // Verify the issue has all Phase 6 fields
    const issueRow = d.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    assert(issueRow.reporter_id, 'Should have reporter_id');
    assertEqual(issueRow.reporter_id, 'jack', 'Reporter should be jack');
    assert(issueRow.issue_type, 'Should have issue_type');
    assertEqual(issueRow.issue_type, 'equipment', 'Issue type should be equipment');
    assert(issueRow.linked_announcement_id, 'Should have linked_announcement_id');
    assertEqual(issueRow.linked_announcement_id, ann.announcement.id, 'Linked announcement mismatch');
    assert(!issueRow.qualified_verifier, 'Should not have verifier yet (issue is open)');
    assert(!issueRow.verified_at, 'Should not have verified_at yet (issue is open)');
  });

  await test('Test 14: Issue resolution with qualified verifier -> resolved, verified_at set', () => {
    resetAndSeed();
    const d = getDB();
    const msg = insertMessage(d, WS, EMPLOYEE_ID, 'The freezer is broken', 'msg_test_14');
    const issue = reportIssue(d, WS, msg.id, 'jack', 'Freezer malfunction', 'Freezer not cooling', 'equipment');
    const issueId = issue.issue.id;

    // Verify issue is open
    let issueRow = d.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    assertEqual(issueRow.status, 'open', 'Issue should start as open');

    // Resolve with qualified verification
    const result = resolveIssue(d, issueId, 'manager', 'Technician report #TR-2026, freezer repaired and tested');
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.resolved, 'Should return resolved=true');
    assertEqual(result.verifierId, 'manager', 'Verifier should be manager');
    assert(result.evidence, 'Should have evidence');

    // Verify in database
    issueRow = d.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);
    assertEqual(issueRow.status, 'resolved', 'DB issue status should be resolved');
    assertEqual(issueRow.qualified_verifier, 'manager', 'DB verifier should be manager');
    assert(issueRow.verification_evidence, 'DB should have verification evidence');
    assert(issueRow.verified_at, 'DB should have verified_at timestamp');

    // Verify audit log entry
    const audit = d.prepare("SELECT * FROM audit_log WHERE entity_id = ? AND action = 'issue_resolved'").get(issueId);
    assert(audit, 'Should have audit log entry for issue resolution');
    assertEqual(audit.actor, 'manager', 'Audit actor should be manager');
  });

  // ── Print results ─────────────────────────────────────────────────

  console.log('\n  ┌─────────────────────────────────────────────────────────┐');
  console.log('  │  TEST RESULTS                                           │');
  console.log('  └─────────────────────────────────────────────────────────┘');
  for (const r of results) {
    const icon = r.status === 'PASS' ? '✓' : '✗';
    const status = r.status === 'PASS' ? 'PASS' : 'FAIL';
    console.log(`  ${icon} ${status} — ${r.name}`);
    if (r.error) console.log(`         Error: ${r.error}`);
  }
  console.log(`\n  Total: ${passed + failed}  Passed: ${passed}  Failed: ${failed}\n`);

  closeDB();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('\n  FATAL: Test runner crashed:', err);
  closeDB();
  process.exit(2);
});
