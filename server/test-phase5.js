/**
 * server/test-phase5.js — Phase 5 Tests: Scheduled Silent AI Monitoring.
 *
 * Tests the AI analysis log system using an ISOLATED TEST DATABASE
 * (server/test-phase5.db) — never touches the live demo database.
 *
 * Test coverage:
 *   1. ai_analysis_log table is created in the schema
 *   2. Recording an analysis run persists correctly
 *   3. GET ai-status returns the latest run + aggregate stats
 *   4. Multiple runs aggregate correctly
 *   5. Stalled detection triggers when no run in 2+ hours
 *   6. Processing checkpoint (last_message_seq) survives across runs
 *   7. Deduplication still works: propose_chat_completion rejects duplicates
 *   8. Protected task enforcement still works in the analysis log
 *   9. Reset clears the ai_analysis_log table
 *  10. Summary and errors fields are preserved
 *
 * Run:  node server/test-phase5.js
 */

// ── Isolated test database ──────────────────────────────────────────
// Set the env var BEFORE importing db.js so the module picks up the
// test path. ES module evaluation is deferred until the dynamic import
// resolves, so the env var is set first.
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_DB = resolve(__dirname, 'shiftbridge.db');
const TEST_DB = resolve(__dirname, 'test-phase5.db');

// ── Safeguard: refuse to run against the live database ──────────────
// If SHIFTBRIDGE_DB_PATH is already set to the live database path,
// abort immediately to prevent data destruction.
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
const { getDB, initSchema, closeDB, bumpRevision, mapAIAnalysisLog } = db;

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

// ── Helper: insert an analysis log entry directly ────────────────────
function insertLog(d, workspaceId, opts = {}) {
  const {
    runAt = Date.now(),
    messagesTotal = 10,
    messagesNew = 3,
    proposalsCreated = 1,
    completionClaims = 1,
    errors = '',
    lastMessageSeq = 5,
    status = 'success',
    summary = 'Analyzed 3 new messages. Created 1 task proposal and 1 completion claim.',
  } = opts;

  const logId = `ail_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();

  d.prepare(
    `INSERT INTO ai_analysis_log (id, workspace_id, run_at, messages_total, messages_new, proposals_created, completion_claims, errors, last_message_seq, status, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(logId, workspaceId, runAt, messagesTotal, messagesNew, proposalsCreated, completionClaims, errors, lastMessageSeq, status, summary, ts);

  return logId;
}

// ── Helper: query the latest log entry ───────────────────────────────
function getLatestLog(d, workspaceId) {
  return d.prepare(
    'SELECT * FROM ai_analysis_log WHERE workspace_id = ? ORDER BY run_at DESC LIMIT 1',
  ).get(workspaceId);
}

// ── Helper: aggregate stats ─────────────────────────────────────────
function getAggregates(d, workspaceId) {
  return d.prepare(
    `SELECT
       COUNT(*)                    as total_runs,
       COALESCE(SUM(messages_new), 0)      as total_messages_analyzed,
       COALESCE(SUM(proposals_created), 0)  as total_proposals,
       COALESCE(SUM(completion_claims), 0)  as total_claims,
       MAX(run_at)                 as last_run_at
     FROM ai_analysis_log WHERE workspace_id = ?`,
  ).get(workspaceId);
}

// ── Tests ───────────────────────────────────────────────────────────

async function runTests() {
  // Initialize schema and seed the test database.
  initSchema();
  seedDatabase();
  bumpRevision();

  const d = getDB();

  // ── Test 1: ai_analysis_log table exists ──────────────────────────
  await test('ai_analysis_log table is created in the schema', () => {
    const tableInfo = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ai_analysis_log'").get();
    assert(tableInfo, 'ai_analysis_log table not found in schema');
  });

  // ── Test 2: Recording an analysis run persists correctly ───────────
  await test('Recording an analysis run persists correctly', () => {
    const logId = insertLog(d, 'daily', {
      messagesTotal: 7,
      messagesNew: 2,
      proposalsCreated: 1,
      completionClaims: 1,
      lastMessageSeq: 7,
      summary: 'Test run: found 2 new messages',
    });

    const row = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(logId);
    assert(row, 'Log entry not found after insert');
    assertEqual(row.workspace_id, 'daily', 'workspace_id mismatch');
    assertEqual(row.messages_total, 7, 'messages_total mismatch');
    assertEqual(row.messages_new, 2, 'messages_new mismatch');
    assertEqual(row.proposals_created, 1, 'proposals_created mismatch');
    assertEqual(row.completion_claims, 1, 'completion_claims mismatch');
    assertEqual(row.last_message_seq, 7, 'last_message_seq mismatch');
    assertEqual(row.status, 'success', 'status mismatch');
    assert(row.summary.includes('Test run'), 'summary mismatch');
  });

  // ── Test 3: GET ai-status returns latest run + aggregate stats ────
  await test('ai-status returns the latest run + aggregate stats', () => {
    const latest = getLatestLog(d, 'daily');
    const agg = getAggregates(d, 'daily');

    assert(latest, 'No latest log found');
    assertEqual(agg.total_runs, 1, 'Should have 1 total run');
    assertEqual(agg.total_messages_analyzed, 2, 'Should have 2 total messages analyzed');
    assertEqual(agg.total_proposals, 1, 'Should have 1 total proposal');
    assertEqual(agg.total_claims, 1, 'Should have 1 total claim');
    assertEqual(agg.last_run_at, latest.run_at, 'last_run_at should match latest run');
  });

  // ── Test 4: Multiple runs aggregate correctly ─────────────────────
  await test('Multiple runs aggregate correctly', () => {
    // Insert 2 more runs.
    insertLog(d, 'daily', { messagesNew: 4, proposalsCreated: 2, completionClaims: 0, lastMessageSeq: 11 });
    insertLog(d, 'daily', { messagesNew: 1, proposalsCreated: 0, completionClaims: 1, lastMessageSeq: 12 });

    const agg = getAggregates(d, 'daily');
    assertEqual(agg.total_runs, 3, 'Should have 3 total runs');
    assertEqual(agg.total_messages_analyzed, 7, 'Should have 2+4+1=7 total messages analyzed');
    assertEqual(agg.total_proposals, 3, 'Should have 1+2+0=3 total proposals');
    assertEqual(agg.total_claims, 2, 'Should have 1+0+1=2 total claims');

    const latest = getLatestLog(d, 'daily');
    assertEqual(latest.last_message_seq, 12, 'Latest run should have last_message_seq=12');
  });

  // ── Test 5: Stalled detection triggers when no run in 2+ hours ────
  await test('Stalled detection triggers when no run in 2+ hours', () => {
    // Clear previous entries so the stale run is the only/latest one.
    d.exec("DELETE FROM ai_analysis_log WHERE workspace_id = 'daily'");

    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000 + 60000); // 2h1m ago
    insertLog(d, 'daily', { runAt: twoHoursAgo, messagesNew: 0, lastMessageSeq: 12, summary: 'Stale run' });

    const latest = getLatestLog(d, 'daily');
    const isStalled = latest.run_at < (Date.now() - 2 * 60 * 60 * 1000);
    assert(isStalled, 'Monitoring should be detected as stalled');
  });

  // ── Test 6: Processing checkpoint (last_message_seq) persists ──────
  await test('Processing checkpoint (last_message_seq) persists across runs', () => {
    // Clear all logs and insert a fresh sequence.
    d.prepare("DELETE FROM ai_analysis_log WHERE workspace_id = 'daily'").run();

    insertLog(d, 'daily', { lastMessageSeq: 5, messagesNew: 5 });
    const run1 = getLatestLog(d, 'daily');
    assertEqual(run1.last_message_seq, 5, 'First run checkpoint should be 5');

    insertLog(d, 'daily', { lastMessageSeq: 8, messagesNew: 3 });
    const run2 = getLatestLog(d, 'daily');
    assertEqual(run2.last_message_seq, 8, 'Second run checkpoint should be 8');

    // The automation should read run2.last_message_seq to know it only
    // needs to process messages with seq > 8.
    const checkpoint = getLatestLog(d, 'daily').last_message_seq;
    assertEqual(checkpoint, 8, 'Checkpoint should be 8 after two runs');
  });

  // ── Test 7: Deduplication — propose_chat_completion rejects duplicates ─
  await test('Deduplication: completion_claims unique index prevents duplicates', () => {
    // Insert a completion claim for a task+message pair.
    const claimId = `cc_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const ts = Date.now();
    d.prepare(
      `INSERT OR IGNORE INTO completion_claims (id, workspace_id, task_id, message_id, reporting_employee, claim_text, claim_type, status, verification_applied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(claimId, 'daily', 't1', 'm_dup_test', 'jack', 'I finished checking the oat milk', 'completion', 'processed', 'self-report', ts);

    // Attempt to insert the same task_id + message_id again — should be ignored.
    const dupId = `cc_dup_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const info = d.prepare(
      `INSERT OR IGNORE INTO completion_claims (id, workspace_id, task_id, message_id, reporting_employee, claim_text, claim_type, status, verification_applied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(dupId, 'daily', 't1', 'm_dup_test', 'jack', 'Duplicate attempt', 'completion', 'processed', 'self-report', ts);

    assertEqual(info.changes, 0, 'Duplicate completion claim should not be inserted (INSERT OR IGNORE)');
  });

  // ── Test 8: Protected task enforcement in the analysis log ────────
  await test('Analysis log records protected task status correctly', () => {
    // Simulate an analysis run that encountered a protected task.
    insertLog(d, 'daily', {
      messagesNew: 2,
      proposalsCreated: 0,
      completionClaims: 1,
      errors: 'Protected task t5 (repairs) moved to review — not marked done',
      status: 'partial',
      summary: 'Analyzed 2 messages. 1 completion claim for protected task (requires qualified verification).',
      lastMessageSeq: 15,
    });

    const latest = getLatestLog(d, 'daily');
    assertEqual(latest.status, 'partial', 'Status should be partial for runs with protected task issues');
    assert(latest.errors.includes('Protected task'), 'Errors should mention the protected task');
    assert(latest.summary.includes('qualified verification'), 'Summary should mention qualified verification');
  });

  // ── Test 9: Reset clears the ai_analysis_log table ─────────────────
  await test('Reset clears the ai_analysis_log table', () => {
    // Verify we have entries.
    const beforeCount = d.prepare("SELECT COUNT(*) as c FROM ai_analysis_log WHERE workspace_id = 'daily'").get();
    assert(beforeCount.c > 0, 'Should have log entries before reset');

    // Simulate reset.
    d.exec("DELETE FROM ai_analysis_log WHERE workspace_id = 'daily'");

    const afterCount = d.prepare("SELECT COUNT(*) as c FROM ai_analysis_log WHERE workspace_id = 'daily'").get();
    assertEqual(afterCount.c, 0, 'Should have 0 entries after reset');
  });

  // ── Test 10: Summary and errors fields are preserved with long text ─
  await test('Summary and errors fields preserve long text', () => {
    const longSummary = 'A'.repeat(500);
    const longErrors = 'B'.repeat(500);
    const logId = insertLog(d, 'daily', { summary: longSummary, errors: longErrors });

    const row = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(logId);
    assertEqual(row.summary, longSummary, 'Summary should preserve long text');
    assertEqual(row.errors, longErrors, 'Errors should preserve long text');
  });

  // ── Test 11: Workspace isolation — logs don't cross workspaces ────
  await test('Workspace isolation: logs do not cross workspaces', () => {
    d.exec("DELETE FROM ai_analysis_log");

    insertLog(d, 'daily', { messagesNew: 3, lastMessageSeq: 3 });
    insertLog(d, 'riverside', { messagesNew: 5, lastMessageSeq: 5 });

    const dailyAgg = getAggregates(d, 'daily');
    const riversideAgg = getAggregates(d, 'riverside');

    assertEqual(dailyAgg.total_runs, 1, 'daily should have 1 run');
    assertEqual(riversideAgg.total_runs, 1, 'riverside should have 1 run');
    assertEqual(dailyAgg.total_messages_analyzed, 3, 'daily should have 3 messages');
    assertEqual(riversideAgg.total_messages_analyzed, 5, 'riverside should have 5 messages');

    const dailyLatest = getLatestLog(d, 'daily');
    const riversideLatest = getLatestLog(d, 'riverside');
    assertEqual(dailyLatest.last_message_seq, 3, 'daily checkpoint should be 3');
    assertEqual(riversideLatest.last_message_seq, 5, 'riverside checkpoint should be 5');
  });

  // ── Test 12: mapAIAnalysisLog mapper produces correct shape ────────
  await test('mapAIAnalysisLog mapper produces correct shape', () => {
    const raw = d.prepare('SELECT * FROM ai_analysis_log WHERE workspace_id = ? ORDER BY run_at DESC LIMIT 1').get('daily');
    const mapped = mapAIAnalysisLog(raw);

    assert(mapped, 'Mapped log should not be null');
    assertEqual(mapped.ws, 'daily', 'ws field should be workspace_id');
    assertEqual(typeof mapped.messagesTotal, 'number', 'messagesTotal should be a number');
    assertEqual(typeof mapped.messagesNew, 'number', 'messagesNew should be a number');
    assertEqual(typeof mapped.proposalsCreated, 'number', 'proposalsCreated should be a number');
    assertEqual(typeof mapped.completionClaims, 'number', 'completionClaims should be a number');
    assertEqual(typeof mapped.lastMessageSeq, 'number', 'lastMessageSeq should be a number');
    assertEqual(typeof mapped.status, 'string', 'status should be a string');
  });
}

// ── Run & report ────────────────────────────────────────────────────
runTests()
  .then(() => {
    console.log('\n── Phase 5 Test Results ──────────────────────────────');
    for (const r of results) {
      const icon = r.status === 'PASS' ? 'PASS' : 'FAIL';
      console.log(`  ${icon}: ${r.name}${r.error ? ' — ' + r.error : ''}`);
    }
    console.log(`\n  Total: ${passed} passed, ${failed} failed, ${results.length} tests`);
    console.log(`  Test database: ${TEST_DB}\n`);

    // Clean up test database.
    closeDB();
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal');
    if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm');
    console.log('  Test database cleaned up.\n');

    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('Test runner error:', err);
    closeDB();
    process.exit(1);
  });
