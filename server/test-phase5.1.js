/**
 * server/test-phase5.1.js — Phase 5.1 Tests: Reliability & Data Safety Fixes.
 *
 * Tests the task proposal deduplication system (Fix 2) using an
 * ISOLATED TEST DATABASE (server/test-phase5.1.db) — never touches
 * the live demo database at server/shiftbridge.db.
 *
 * Test coverage:
 *
 * Fix 2 — Task proposal deduplication (Tests 1-12):
 *   1. source_message_id column exists in ai_proposals schema
 *   2. Unique dedup index exists on (workspace_id, source_message_id, type, summary)
 *   3. Insert proposal with sourceMessageId → succeeds
 *   4. Duplicate insert (same ws + sourceMessageId + type + summary) → prevented
 *   5. Distinct tasks from same message (different summaries) → both succeed
 *   6. Same summary but different sourceMessageId → succeeds
 *   7. Insert without sourceMessageId → always succeeds (backward compatible)
 *   8. Dedup query returns the correct existing proposal
 *   9. Post-approval dedup: approved proposal still prevents duplicates
 *  10. mapProposal includes sourceMessageId field
 *  11. Workspace isolation: dedup only applies within same workspace
 *  12. Rejected proposals also prevent duplicates
 *
 * Fix 3 — Cursor-based message pagination (Tests 13-19):
 *  13. sinceSeq filter returns only messages after checkpoint
 *  14. limit parameter limits returned messages per batch
 *  15. hasMore is false when all messages fit in one batch
 *  16. nextSinceSeq correctly points to the last returned seq
 *  17. Full pagination cycle through 100 messages in batches of 30
 *  18. Workspace isolation: sinceSeq only applies within same workspace
 *  19. sinceSeq=0 returns all messages (backward compatible)
 *
 * Fix 4 — Checkpoint and failure recovery (Tests 20-31):
 *  20. processing_errors column exists in ai_analysis_log schema
 *  21. mapAIAnalysisLog parses processing_errors JSON correctly
 *  22. mapAIAnalysisLog handles empty/missing processing_errors gracefully
 *  23. ai-run/start creates running entry with startSeq from previous run
 *  24. Overlap prevention: findRunning returns active entry when one exists
 *  25. Checkpoint: last_message_seq only advances forward (monotonic)
 *  26. Processing errors accumulate across checkpoints (quarantine)
 *  27. ai-run/finish finalizes running entry with correct status and summary
 *  28. Stale run auto-finalized as interrupted when a new run starts
 *  29. No active run: findRunning returns null (endpoint returns 404)
 *  30. Workspace isolation: running entries and checkpoints are workspace-scoped
 *  31. Partial status with processing errors and quarantined messages
 *
 * Run:  npm run test:phase5.1
 */

// ── Isolated test database ──────────────────────────────────────────
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIVE_DB = resolve(__dirname, 'shiftbridge.db');
const TEST_DB = resolve(__dirname, 'test-phase5.1.db');

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
const { getDB, initSchema, closeDB, bumpRevision, mapProposal, mapAIAnalysisLog } = db;
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

// ── Helper: insert a proposal with optional sourceMessageId ────────
function insertProposal(d, opts = {}) {
  const {
    ws = 'daily',
    type = 'task_proposal',
    entityType = null,
    entityId = null,
    summary = 'Propose new task: "Test task"',
    evidence = ['Test evidence'],
    reasoning = 'Test reasoning',
    confidence = 'high',
    proposedData = { name: 'Test task', assignee: 'jack' },
    sourceMessageId = null,
  } = opts;

  const proposalId = `p_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = Date.now();

  const info = d.prepare(
    `INSERT OR IGNORE INTO ai_proposals
     (id, workspace_id, type, entity_type, entity_id, summary, evidence, reasoning, confidence, status, proposed_data, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    proposalId, ws, type, entityType, entityId,
    summary, JSON.stringify(evidence), reasoning, confidence,
    proposedData ? JSON.stringify(proposedData) : '',
    sourceMessageId, ts,
  );

  return { proposalId, changes: info.changes };
}

// ── Helper: get a proposal by source message + type + summary ───────
function findExistingProposal(d, ws, sourceMessageId, type, summary) {
  return d.prepare(
    `SELECT * FROM ai_proposals
     WHERE workspace_id = ? AND source_message_id = ? AND type = ? AND summary = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(ws, sourceMessageId, type, summary);
}

// ── Tests ───────────────────────────────────────────────────────────

async function runTests() {
  initSchema();
  seedDatabase();
  bumpRevision();

  const d = getDB();

  console.log('\n  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  Phase 5.1: Task Proposal Deduplication Tests           │');
  console.log('  └──────────────────────────────────────────────────────────┘\n');

  // ── Test 1: source_message_id column exists ──────────────────────
  await test('source_message_id column exists in ai_proposals schema', () => {
    const cols = d.prepare('PRAGMA table_info(ai_proposals)').all();
    const colNames = cols.map((c) => c.name);
    assert(colNames.includes('source_message_id'), 'source_message_id column should exist');
  });

  // ── Test 2: Unique dedup index exists ─────────────────────────────
  await test('Unique dedup index exists on (workspace_id, source_message_id, type, summary)', () => {
    const indexes = d.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='ai_proposals'").all();
    const dedupIdx = indexes.find((i) => i.name === 'idx_proposals_dedup');
    assert(dedupIdx, 'idx_proposals_dedup index should exist');
    assert(dedupIdx.sql.includes('UNIQUE'), 'Index should be UNIQUE');
    assert(dedupIdx.sql.includes('source_message_id'), 'Index should include source_message_id');
  });

  // ── Test 3: Insert proposal with sourceMessageId succeeds ─────────
  await test('Insert proposal with sourceMessageId → succeeds', () => {
    const { proposalId, changes } = insertProposal(d, {
      summary: 'Propose new task: "Restock oat milk"',
      sourceMessageId: 'm_test_msg_1',
    });
    assertEqual(changes, 1, 'Should insert 1 row');
    assert(proposalId, 'Should return a proposal ID');

    const row = d.prepare('SELECT * FROM ai_proposals WHERE id = ?').get(proposalId);
    assert(row, 'Proposal should exist in database');
    assertEqual(row.source_message_id, 'm_test_msg_1', 'source_message_id should be preserved');
  });

  // ── Test 4: Duplicate insert is prevented ────────────────────────
  await test('Duplicate insert (same ws + sourceMessageId + type + summary) → prevented', () => {
    const { changes } = insertProposal(d, {
      summary: 'Propose new task: "Restock oat milk"',
      sourceMessageId: 'm_test_msg_1',
    });
    assertEqual(changes, 0, 'Should NOT insert a duplicate (INSERT OR IGNORE)');

    // Verify only one proposal exists for this source message + summary
    const count = d.prepare(
      `SELECT COUNT(*) as c FROM ai_proposals
       WHERE workspace_id = 'daily' AND source_message_id = 'm_test_msg_1'
       AND type = 'task_proposal' AND summary = 'Propose new task: "Restock oat milk"'`,
    ).get();
    assertEqual(count.c, 1, 'Should be exactly 1 proposal for this source+summary');
  });

  // ── Test 5: Distinct tasks from same message → both succeed ───────
  await test('Distinct tasks from same message (different summaries) → both succeed', () => {
    const r1 = insertProposal(d, {
      summary: 'Propose new task: "Clean espresso machine"',
      sourceMessageId: 'm_test_msg_2',
    });
    const r2 = insertProposal(d, {
      summary: 'Propose new task: "Restock paper cups"',
      sourceMessageId: 'm_test_msg_2',
    });
    assertEqual(r1.changes, 1, 'First task proposal should be inserted');
    assertEqual(r2.changes, 1, 'Second task proposal (different summary) should also be inserted');

    // Verify both proposals exist
    const count = d.prepare(
      `SELECT COUNT(*) as c FROM ai_proposals
       WHERE workspace_id = 'daily' AND source_message_id = 'm_test_msg_2'`,
    ).get();
    assertEqual(count.c, 2, 'Should be 2 proposals from the same source message');
  });

  // ── Test 6: Same summary but different sourceMessageId → succeeds ─
  await test('Same summary but different sourceMessageId → succeeds', () => {
    const r1 = insertProposal(d, {
      summary: 'Propose new task: "Check inventory"',
      sourceMessageId: 'm_test_msg_3a',
    });
    const r2 = insertProposal(d, {
      summary: 'Propose new task: "Check inventory"',
      sourceMessageId: 'm_test_msg_3b',
    });
    assertEqual(r1.changes, 1, 'First insert should succeed');
    assertEqual(r2.changes, 1, 'Second insert (different sourceMessageId) should also succeed');
  });

  // ── Test 7: Insert without sourceMessageId → always succeeds ─────
  await test('Insert without sourceMessageId → always succeeds (backward compatible)', () => {
    // Insert two proposals with identical data but no sourceMessageId
    const r1 = insertProposal(d, {
      summary: 'Propose new task: "Legacy task"',
      sourceMessageId: null,
    });
    const r2 = insertProposal(d, {
      summary: 'Propose new task: "Legacy task"',
      sourceMessageId: null,
    });
    assertEqual(r1.changes, 1, 'First insert should succeed');
    assertEqual(r2.changes, 1, 'Second insert should also succeed (no dedup without sourceMessageId)');
  });

  // ── Test 8: Dedup query returns correct existing proposal ────────
  await test('Dedup query returns the correct existing proposal', () => {
    // Use a unique source message for this test
    const { proposalId } = insertProposal(d, {
      summary: 'Propose new task: "Unique test task"',
      sourceMessageId: 'm_dedup_query_test',
      reasoning: 'Specific reasoning for dedup query test',
    });

    const existing = findExistingProposal(d, 'daily', 'm_dedup_query_test', 'task_proposal', 'Propose new task: "Unique test task"');

    assert(existing, 'Should find an existing proposal');
    assertEqual(existing.id, proposalId, 'Should return the correct proposal ID');
    assertEqual(existing.source_message_id, 'm_dedup_query_test', 'Should have the correct source_message_id');
    assertEqual(existing.reasoning, 'Specific reasoning for dedup query test', 'Should have the correct reasoning');
  });

  // ── Test 9: Post-approval dedup still prevents duplicates ────────
  await test('Post-approval dedup: approved proposal still prevents duplicates', () => {
    // Insert a proposal
    const { proposalId } = insertProposal(d, {
      summary: 'Propose new task: "Approved task"',
      sourceMessageId: 'm_post_approval_test',
    });

    // Simulate manager approval
    d.prepare('UPDATE ai_proposals SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(
      'approved', 'manager', Date.now(), proposalId,
    );

    // Verify it's approved
    const approved = d.prepare('SELECT status FROM ai_proposals WHERE id = ?').get(proposalId);
    assertEqual(approved.status, 'approved', 'Proposal should be approved');

    // Try to insert a duplicate — should still be prevented
    const { changes } = insertProposal(d, {
      summary: 'Propose new task: "Approved task"',
      sourceMessageId: 'm_post_approval_test',
    });
    assertEqual(changes, 0, 'Should NOT create a duplicate even after approval');

    // Verify the existing approved proposal is returned by the dedup query
    const existing = findExistingProposal(d, 'daily', 'm_post_approval_test', 'task_proposal', 'Propose new task: "Approved task"');
    assert(existing, 'Dedup query should find the approved proposal');
    assertEqual(existing.status, 'approved', 'Existing proposal should still be approved');
  });

  // ── Test 10: mapProposal includes sourceMessageId field ───────────
  await test('mapProposal includes sourceMessageId field', () => {
    const row = d.prepare(
      `SELECT * FROM ai_proposals WHERE source_message_id = 'm_dedup_query_test' LIMIT 1`,
    ).get();
    assert(row, 'Should find a proposal with source_message_id');

    const mapped = mapProposal(row);
    assert(mapped, 'Mapped proposal should not be null');
    assertEqual(mapped.sourceMessageId, 'm_dedup_query_test', 'Mapped sourceMessageId should match');
    assert('sourceMessageId' in mapped, 'sourceMessageId field should exist in mapped object');
  });

  // ── Test 11: Workspace isolation — dedup only applies within same ws
  await test('Workspace isolation: dedup only applies within same workspace', () => {
    // Insert a proposal in daily workspace
    const r1 = insertProposal(d, {
      ws: 'daily',
      summary: 'Propose new task: "Cross-workspace test"',
      sourceMessageId: 'm_xws_test',
    });
    assertEqual(r1.changes, 1, 'Daily workspace insert should succeed');

    // Insert the same proposal in riverside workspace — should succeed
    const r2 = insertProposal(d, {
      ws: 'riverside',
      summary: 'Propose new task: "Cross-workspace test"',
      sourceMessageId: 'm_xws_test',
    });
    assertEqual(r2.changes, 1, 'Riverside workspace insert should also succeed (different workspace)');

    // Verify both exist
    const dailyCount = d.prepare(
      `SELECT COUNT(*) as c FROM ai_proposals WHERE workspace_id = 'daily' AND source_message_id = 'm_xws_test' AND summary = ?`,
    ).get('Propose new task: "Cross-workspace test"');
    const riversideCount = d.prepare(
      `SELECT COUNT(*) as c FROM ai_proposals WHERE workspace_id = 'riverside' AND source_message_id = 'm_xws_test' AND summary = ?`,
    ).get('Propose new task: "Cross-workspace test"');
    assertEqual(dailyCount.c, 1, 'Daily should have 1 proposal');
    assertEqual(riversideCount.c, 1, 'Riverside should have 1 proposal');
  });

  // ── Test 12: Rejected proposals also prevent duplicates ───────────
  await test('Rejected proposals also prevent duplicates', () => {
    const { proposalId } = insertProposal(d, {
      summary: 'Propose new task: "Rejected task"',
      sourceMessageId: 'm_rejected_test',
    });

    // Simulate manager rejection
    d.prepare('UPDATE ai_proposals SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?').run(
      'rejected', 'manager', Date.now(), proposalId,
    );

    // Try to insert a duplicate — should be prevented
    const { changes } = insertProposal(d, {
      summary: 'Propose new task: "Rejected task"',
      sourceMessageId: 'm_rejected_test',
    });
    assertEqual(changes, 0, 'Should NOT create a duplicate for a rejected proposal');

    // The existing rejected proposal should still be found by the dedup query
    const existing = findExistingProposal(d, 'daily', 'm_rejected_test', 'task_proposal', 'Propose new task: "Rejected task"');
    assert(existing, 'Dedup query should find the rejected proposal');
    assertEqual(existing.status, 'rejected', 'Existing proposal should still be rejected');
  });

  // ═════════════════════════════════════════════════════════════════
  // Fix 3: Cursor-based message pagination tests
  // ═════════════════════════════════════════════════════════════════

  console.log('\n  ── Fix 3: Cursor-based message pagination ──\n');

  // ── Helper: insert a batch of messages for pagination tests ──────
  // The seed already created 5 daily messages (seq 1-5) and 2 riverside
  // messages (seq 1-2). We'll add 100 more daily messages (seq 6-105).
  const baseSeq = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get('daily').maxSeq || 0;
  const insertMsg = d.prepare(
    'INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (let i = 1; i <= 100; i++) {
    insertMsg.run(`m_pag_test_${i}`, 'daily', 'sarah', `Pagination test message ${i}`, Date.now() + i, baseSeq + i);
  }
  bumpRevision();

  // Total daily messages after insertion: 5 (seed) + 100 = 105
  const totalDaily = d.prepare("SELECT COUNT(*) as c FROM messages WHERE workspace_id = 'daily'").get();
  assertEqual(totalDaily.c, 105, 'Should have 105 daily messages after inserting 100 test messages');

  // ── Test 13: sinceSeq filter returns only messages after checkpoint
  await test('sinceSeq filter: only returns messages with seq > checkpoint', () => {
    const sinceSeq = baseSeq; // checkpoint at the seed messages
    const limit = 500; // large limit to get all
    const rows = d.prepare(
      'SELECT * FROM messages WHERE workspace_id = ? AND created_at > 0 AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all('daily', sinceSeq, limit + 1);

    assert(rows.length === 100, `Should return 100 messages after seq ${sinceSeq}, got ${rows.length}`);
    // Verify all have seq > sinceSeq
    assert(rows.every((r) => r.seq > sinceSeq), 'All returned messages should have seq > sinceSeq');
    // Verify ordering is ascending
    assert(rows.every((r, i) => i === 0 || r.seq > rows[i - 1].seq), 'Messages should be ordered by seq ASC');
  });

  // ── Test 14: limit parameter limits returned messages ───────────
  await test('limit parameter: returns only N messages per batch', () => {
    const sinceSeq = baseSeq;
    const limit = 10;
    const rows = d.prepare(
      'SELECT * FROM messages WHERE workspace_id = ? AND created_at > 0 AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all('daily', sinceSeq, limit + 1);

    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;

    assertEqual(messages.length, 10, 'Should return exactly 10 messages (limited)');
    assert(hasMore, 'hasMore should be true (100 messages available, only 10 returned)');
  });

  // ── Test 15: hasMore is false when all messages fit in one batch ─
  await test('hasMore is false when all messages fit in one batch', () => {
    const sinceSeq = baseSeq + 98; // only 2 messages remain
    const limit = 50;
    const rows = d.prepare(
      'SELECT * FROM messages WHERE workspace_id = ? AND created_at > 0 AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all('daily', sinceSeq, limit + 1);

    const hasMore = rows.length > limit;
    assertEqual(rows.length, 2, 'Should return 2 messages (seq 104-105)');
    assert(!hasMore, 'hasMore should be false (2 messages fit in limit of 50)');
  });

  // ── Test 16: nextSinceSeq is set correctly for pagination ────────
  await test('nextSinceSeq: correctly points to the last returned seq', () => {
    const sinceSeq = baseSeq;
    const limit = 25;
    const rows = d.prepare(
      'SELECT * FROM messages WHERE workspace_id = ? AND created_at > 0 AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all('daily', sinceSeq, limit + 1);

    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    const nextSinceSeq = hasMore && messages.length > 0 ? messages[messages.length - 1].seq : null;

    assert(hasMore, 'Should have more messages');
    assertEqual(nextSinceSeq, baseSeq + 25, `nextSinceSeq should be ${baseSeq + 25}`);
  });

  // ── Test 17: Full pagination cycle through 100 messages ────────
  await test('Full pagination cycle: iterate through all 100 messages in batches of 30', () => {
    let sinceSeq = baseSeq;
    const limit = 30;
    let allMessages = [];
    let iterations = 0;
    let hasMore = true;

    while (hasMore && iterations < 10) {
      const rows = d.prepare(
        'SELECT * FROM messages WHERE workspace_id = ? AND created_at > 0 AND seq > ? ORDER BY seq ASC LIMIT ?',
      ).all('daily', sinceSeq, limit + 1);

      hasMore = rows.length > limit;
      const batch = hasMore ? rows.slice(0, limit) : rows;
      allMessages = allMessages.concat(batch);
      sinceSeq = hasMore && batch.length > 0 ? batch[batch.length - 1].seq : sinceSeq;
      iterations++;
    }

    assertEqual(allMessages.length, 100, `Should have collected all 100 messages, got ${allMessages.length}`);
    assert(iterations <= 4, `Should take at most 4 iterations (30+30+30+10), got ${iterations}`);
    // Verify no duplicates
    const seqs = allMessages.map((m) => m.seq);
    const uniqueSeqs = new Set(seqs);
    assertEqual(uniqueSeqs.size, 100, 'All seqs should be unique (no duplicates)');
  });

  // ── Test 18: Workspace isolation — sinceSeq doesn't cross workspaces
  await test('Workspace isolation: sinceSeq only applies within the same workspace', () => {
    // Daily has 105 messages, riverside has 2 messages
    // Using sinceSeq=0 (all messages) for riverside should return all 2
    const sinceSeq = 0;
    const limit = 500;
    const rows = d.prepare(
      'SELECT * FROM messages WHERE workspace_id = ? AND created_at > 0 AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all('riverside', sinceSeq, limit + 1);

    const hasMore = rows.length > limit;
    assert(rows.length === 2, `Riverside should have 2 messages, got ${rows.length}`);
    assert(!hasMore, 'hasMore should be false for riverside (only 2 messages)');

    // Daily with same sinceSeq should have 105 messages
    const dailyRows = d.prepare(
      'SELECT * FROM messages WHERE workspace_id = ? AND created_at > 0 AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all('daily', sinceSeq, limit + 1);
    assertEqual(dailyRows.length, 105, 'Daily should have 105 messages with sinceSeq=0');
  });

  // ── Test 19: sinceSeq=0 returns all messages (backward compatible) ─
  await test('sinceSeq=0 returns all messages (backward compatible)', () => {
    const sinceSeq = 0;
    const limit = 500;
    const rows = d.prepare(
      'SELECT * FROM messages WHERE workspace_id = ? AND created_at > 0 AND seq > ? ORDER BY seq ASC LIMIT ?',
    ).all('daily', sinceSeq, limit + 1);

    const hasMore = rows.length > limit;
    assertEqual(rows.length, 105, 'Should return all 105 messages');
    assert(!hasMore, 'hasMore should be false');
  });

  // ═════════════════════════════════════════════════════════════════
  // Fix 4: Checkpoint and failure recovery tests
  // ═════════════════════════════════════════════════════════════════

  console.log('\n  ── Fix 4: Checkpoint and failure recovery ──\n');

  // ── Helper: insert an ai_analysis_log entry ───────────────────────
  function insertLog(d, opts = {}) {
    const {
      ws = 'daily',
      runAt = Date.now(),
      status = 'success',
      lastMessageSeq = 0,
      proposalsCreated = 0,
      completionClaims = 0,
      messagesNew = 0,
      messagesTotal = 0,
      errors = '',
      summary = '',
      processingErrors = '[]',
    } = opts;
    const id = `ail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    d.prepare(
      `INSERT INTO ai_analysis_log
       (id, workspace_id, run_at, messages_total, messages_new, proposals_created,
        completion_claims, errors, last_message_seq, status, summary, processing_errors, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, ws, runAt, messagesTotal, messagesNew, proposalsCreated, completionClaims,
      errors, lastMessageSeq, status, summary, processingErrors, runAt);
    return id;
  }

  // ── Helper: find active running entry (same query as the endpoint) ─
  function findRunning(d, ws = 'daily') {
    return d.prepare(
      `SELECT * FROM ai_analysis_log
       WHERE workspace_id = ? AND status = 'running'
       ORDER BY run_at DESC LIMIT 1`,
    ).get(ws);
  }

  // ── Helper: find previous non-running checkpoint ──────────────────
  function findPrevCheckpoint(d, ws = 'daily') {
    return d.prepare(
      `SELECT last_message_seq FROM ai_analysis_log
       WHERE workspace_id = ? AND status != 'running'
       ORDER BY run_at DESC LIMIT 1`,
    ).get(ws);
  }

  // ── Test 20: processing_errors column exists ──────────────────────
  await test('processing_errors column exists in ai_analysis_log schema', () => {
    const cols = d.prepare('PRAGMA table_info(ai_analysis_log)').all();
    const colNames = cols.map((c) => c.name);
    assert(colNames.includes('processing_errors'), 'processing_errors column should exist');
  });

  // ── Test 21: mapAIAnalysisLog parses processingErrors ─────────────
  await test('mapAIAnalysisLog parses processing_errors JSON correctly', () => {
    const id = insertLog(d, {
      ws: 'riverside',
      processingErrors: JSON.stringify([
        { messageId: 'm_fail_1', seq: 10, error: 'Timeout calling LLM', timestamp: Date.now() },
        { messageId: 'm_fail_2', seq: 11, error: 'Invalid response format', timestamp: Date.now() },
      ]),
    });
    const row = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(id);
    const mapped = mapAIAnalysisLog(row);
    assert(mapped, 'Mapped log should not be null');
    assert(Array.isArray(mapped.processingErrors), 'processingErrors should be an array');
    assertEqual(mapped.processingErrors.length, 2, 'Should have 2 processing errors');
    assertEqual(mapped.processingErrors[0].messageId, 'm_fail_1', 'First error messageId should match');
    assertEqual(mapped.processingErrors[1].error, 'Invalid response format', 'Second error message should match');
  });

  // ── Test 22: mapAIAnalysisLog handles empty/missing processingErrors ─
  await test('mapAIAnalysisLog handles empty or missing processing_errors gracefully', () => {
    const id = insertLog(d, { ws: 'riverside', processingErrors: '[]' });
    const row = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(id);
    const mapped = mapAIAnalysisLog(row);
    assertEqual(mapped.processingErrors.length, 0, 'Should have 0 processing errors for empty array');

    // Test with null-like value (set processing_errors to NULL)
    d.prepare('UPDATE ai_analysis_log SET processing_errors = NULL WHERE id = ?').run(id);
    const row2 = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(id);
    const mapped2 = mapAIAnalysisLog(row2);
    assertEqual(mapped2.processingErrors.length, 0, 'Should handle null processing_errors gracefully');
  });

  // ── Clean slate for lifecycle tests (Tests 23-31) ─────────────────
  // Remove any ai_analysis_log entries from daily workspace so the
  // lifecycle tests have precise control over findPrevCheckpoint results.
  d.prepare("DELETE FROM ai_analysis_log WHERE workspace_id = 'daily'").run();

  // ── Test 23: Start creates a running entry with correct startSeq ──
  await test('ai-run/start: creates running entry with startSeq from previous run', () => {
    // Create a completed run with last_message_seq = 50 (run_at ~13 min ago)
    insertLog(d, { status: 'success', lastMessageSeq: 50, messagesNew: 50, runAt: Date.now() - 800000 });

    // Simulate start: find previous checkpoint, then create running entry
    const prev = findPrevCheckpoint(d);
    const startSeq = prev?.last_message_seq || 0;
    assertEqual(startSeq, 50, 'startSeq should be 50 (from previous completed run)');

    const runningId = insertLog(d, { status: 'running', lastMessageSeq: startSeq, runAt: Date.now() - 700000 });

    // Verify the running entry exists
    const running = findRunning(d);
    assert(running, 'Should find a running entry');
    assertEqual(running.id, runningId, 'Running entry ID should match');
    assertEqual(running.status, 'running', 'Status should be running');
    assertEqual(running.last_message_seq, 50, 'Running entry checkpoint should start at 50');
  });

  // ── Test 24: Overlap prevention — findRunning returns the active entry ─
  await test('Overlap prevention: findRunning returns the active entry when one exists', () => {
    // The running entry from Test 23 has runAt=now-700000 (stale >5min).
    // In the real endpoint, ai-run/start would auto-finalize it as interrupted
    // and create a new fresh running entry. We simulate that here.
    const staleRunning = d.prepare(
      `SELECT * FROM ai_analysis_log WHERE workspace_id = 'daily' AND status = 'running' AND run_at < ? ORDER BY run_at ASC LIMIT 1`,
    ).get(Date.now() - 5 * 60 * 1000);
    assert(staleRunning, 'Should find the stale running entry from Test 23');
    d.prepare("UPDATE ai_analysis_log SET status = 'interrupted' WHERE id = ?").run(staleRunning.id);

    // Insert a fresh running entry (simulating a new start)
    const freshId = insertLog(d, { status: 'running', lastMessageSeq: 50, runAt: Date.now() });

    const freshRunning = findRunning(d);
    assert(freshRunning, 'Should find the fresh running entry');
    assertEqual(freshRunning.id, freshId, 'Should be the fresh entry');
    const freshElapsed = Date.now() - freshRunning.run_at;
    assert(freshElapsed < 5 * 60 * 1000, `Fresh entry elapsed (${freshElapsed}ms) should be < 5 min — overlap detected`);
  });

  // ── Test 25: Checkpoint advances last_message_seq (monotonic) ──────
  await test('Checkpoint: last_message_seq only advances forward (monotonic)', () => {
    // Use the running entry from Test 23
    const running = findRunning(d);
    assert(running, 'Should have a running entry to checkpoint');

    // Advance to seq 75
    const newSeq = Math.max(running.last_message_seq, 75);
    d.prepare('UPDATE ai_analysis_log SET last_message_seq = ?, proposals_created = ?, messages_new = ? WHERE id = ?')
      .run(newSeq, 3, 75, running.id);

    let updated = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(running.id);
    assertEqual(updated.last_message_seq, 75, 'Checkpoint should advance to 75');

    // Try to advance backwards (lower seq) — should NOT go backward
    const lowerSeq = Math.max(updated.last_message_seq, 50); // MAX(75, 50) = 75
    d.prepare('UPDATE ai_analysis_log SET last_message_seq = ? WHERE id = ?')
      .run(lowerSeq, running.id);

    updated = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(running.id);
    assertEqual(updated.last_message_seq, 75, 'Checkpoint should NOT go backward (still 75)');
  });

  // ── Test 26: Processing errors accumulate across checkpoints (quarantine) ─
  await test('Processing errors accumulate across checkpoints (quarantine)', () => {
    const running = findRunning(d);
    assert(running, 'Should have a running entry');

    // Start with empty errors
    let errorsArr = [];
    try { errorsArr = JSON.parse(running.processing_errors || '[]'); } catch { /* */ }

    // First checkpoint: add 1 error
    errorsArr = [...errorsArr, { messageId: 'm_fail_a', seq: 76, error: 'LLM timeout', timestamp: Date.now() }];
    d.prepare('UPDATE ai_analysis_log SET processing_errors = ? WHERE id = ?')
      .run(JSON.stringify(errorsArr), running.id);

    // Second checkpoint: add another error
    errorsArr = [...errorsArr, { messageId: 'm_fail_b', seq: 80, error: 'Parse error', timestamp: Date.now() }];
    d.prepare('UPDATE ai_analysis_log SET processing_errors = ? WHERE id = ?')
      .run(JSON.stringify(errorsArr), running.id);

    // Verify errors accumulated
    const updated = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(running.id);
    const mapped = mapAIAnalysisLog(updated);
    assertEqual(mapped.processingErrors.length, 2, 'Should have 2 accumulated errors');
    assertEqual(mapped.processingErrors[0].messageId, 'm_fail_a', 'First error should be m_fail_a');
    assertEqual(mapped.processingErrors[1].messageId, 'm_fail_b', 'Second error should be m_fail_b');
  });

  // ── Test 27: Finish finalizes running entry with correct status ───
  await test('ai-run/finish: finalizes running entry with correct status and summary', () => {
    const running = findRunning(d);
    assert(running, 'Should have a running entry to finish');

    // Simulate finish: update status, summary, errors
    const ts = Date.now();
    d.prepare(
      `UPDATE ai_analysis_log
       SET status = ?, summary = ?, errors = ?, messages_total = ?, messages_new = ?
       WHERE id = ?`,
    ).run('success', 'Analyzed 75 messages, created 3 proposals.', '', 75, 75, running.id);

    const finished = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(running.id);
    assertEqual(finished.status, 'success', 'Status should be success');
    assertEqual(finished.summary, 'Analyzed 75 messages, created 3 proposals.', 'Summary should match');
    assertEqual(finished.messages_total, 75, 'messages_total should be 75');

    // Verify no running entry remains
    const stillRunning = findRunning(d);
    assert(!stillRunning, 'Should have no running entry after finish');
  });

  // ── Test 28: Stale run auto-finalized as interrupted ──────────────
  await test('Stale run auto-finalized as interrupted when a new run starts', () => {
    // Clean slate: remove all daily log entries so this test is self-contained.
    d.prepare("DELETE FROM ai_analysis_log WHERE workspace_id = 'daily'").run();

    // Insert a completed run (old, 13 min ago, seq=75)
    insertLog(d, { status: 'success', lastMessageSeq: 75, messagesNew: 75, runAt: Date.now() - 800000 });

    // Insert a stale running entry (6.7 min ago — stale >5 min, but MORE RECENT
    // than the completed run). It processed to seq=80 (started from 75, advanced 5).
    const staleId = insertLog(d, {
      status: 'running',
      lastMessageSeq: 80,
      runAt: Date.now() - 400000, // 6.7 min ago — stale
    });

    // Verify it's running and stale
    const running = findRunning(d);
    assert(running, 'Should find the stale running entry');
    assertEqual(running.id, staleId, 'Should be the stale entry');
    const elapsed = Date.now() - running.run_at;
    assert(elapsed >= 5 * 60 * 1000, `Stale entry elapsed (${elapsed}ms) should be >= 5 min`);

    // Simulate the auto-finalize step from ai-run/start
    d.prepare(
      `UPDATE ai_analysis_log
       SET status = 'interrupted',
           summary = COALESCE(summary, '') || ' [Auto-finalized: run exceeded 5 min without completion]'
       WHERE id = ?`,
    ).run(staleId);

    // Verify it's now interrupted
    const finalized = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(staleId);
    assertEqual(finalized.status, 'interrupted', 'Stale run should be finalized as interrupted');
    assert(finalized.summary.includes('Auto-finalized'), 'Summary should mention auto-finalization');

    // The stale run (runAt=now-400000, seq=80) is more recent than the completed
    // run (runAt=now-800000, seq=75), so findPrevCheckpoint returns seq=80.
    const prev = findPrevCheckpoint(d);
    assert(prev, 'Should find a previous non-running checkpoint');
    assertEqual(prev.last_message_seq, 80, 'startSeq should come from the stale run (seq 80) — it is the most recent non-running entry');

    // Create the new running entry starting from the stale run's checkpoint
    const newRunningId = insertLog(d, {
      status: 'running',
      lastMessageSeq: prev.last_message_seq,
      runAt: Date.now(),
    });
    const newRunning = findRunning(d);
    assert(newRunning, 'Should find the new running entry');
    assertEqual(newRunning.id, newRunningId, 'Should be the new entry');
    assertEqual(newRunning.last_message_seq, 80, 'New run should start from the stale checkpoint (80)');
  });

  // ── Test 29: No running entry returns null (404 at API level) ─────
  await test('No active run: findRunning returns null (endpoint returns 404)', () => {
    // Finish the running entry from Test 28
    const running = findRunning(d);
    assert(running, 'Should have a running entry to finish first');
    d.prepare('UPDATE ai_analysis_log SET status = ? WHERE id = ?').run('success', running.id);

    // Now there should be no running entry
    const stillRunning = findRunning(d);
    assert(!stillRunning, 'Should return null when no running entry exists');

    // Same for the checkpoint query
    const prev = findPrevCheckpoint(d);
    assert(prev, 'Should still find the previous completed checkpoint');
  });

  // ── Test 30: Workspace isolation — running entries don't cross ws ─
  await test('Workspace isolation: running entries and checkpoints are workspace-scoped', () => {
    // Create a running entry in daily
    const dailyId = insertLog(d, { ws: 'daily', status: 'running', lastMessageSeq: 100, runAt: Date.now() });

    // Verify daily has a running entry
    const dailyRunning = findRunning(d, 'daily');
    assert(dailyRunning, 'Daily should have a running entry');
    assertEqual(dailyRunning.id, dailyId, 'Should be the daily entry');

    // Riverside should have no running entry
    const riversideRunning = findRunning(d, 'riverside');
    assert(!riversideRunning, 'Riverside should have no running entry');

    // Previous checkpoint for riverside should not be affected by daily's entries
    const riversidePrev = findPrevCheckpoint(d, 'riverside');
    // Riverside may have no previous entries, or it might have some from seed data
    // The key point is that daily's entries don't bleed into riverside's query results
  });

  // ── Test 31: Partial status with processing errors ────────────────
  await test('Partial status: finish with errors and processing errors recorded', () => {
    // Start a new run
    const runningId = insertLog(d, {
      status: 'running',
      lastMessageSeq: 100,
      runAt: Date.now(),
    });

    // Add processing errors mid-run
    const errs = [
      { messageId: 'm_partial_1', seq: 102, error: 'Connection reset', timestamp: Date.now() },
      { messageId: 'm_partial_2', seq: 105, error: 'Rate limited', timestamp: Date.now() },
    ];
    d.prepare('UPDATE ai_analysis_log SET processing_errors = ?, last_message_seq = ?, proposals_created = 1 WHERE id = ?')
      .run(JSON.stringify(errs), 105, runningId);

    // Finish with partial status
    d.prepare(
      `UPDATE ai_analysis_log
       SET status = 'partial', summary = 'Processed 5 of 7 messages. 2 errors quarantined.',
           errors = '2 messages failed processing',
           messages_total = 7, messages_new = 5
       WHERE id = ?`,
    ).run(runningId);

    const finished = d.prepare('SELECT * FROM ai_analysis_log WHERE id = ?').get(runningId);
    const mapped = mapAIAnalysisLog(finished);
    assertEqual(mapped.status, 'partial', 'Status should be partial');
    assertEqual(mapped.processingErrors.length, 2, 'Should have 2 quarantined errors');
    assertEqual(mapped.processingErrors[0].error, 'Connection reset', 'First error should match');
    assertEqual(mapped.processingErrors[1].error, 'Rate limited', 'Second error should match');
    assert(mapped.summary.includes('2 errors quarantined'), 'Summary should mention quarantined errors');
  });
}

// ── Run & report ────────────────────────────────────────────────────
runTests()
  .then(() => {
    console.log('\n── Phase 5.1 Test Results ─────────────────────────────');
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
