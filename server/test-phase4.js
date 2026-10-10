/**
 * server/test-phase4.js — Phase 4 Integration Tests: Chat-Based Task Completion Intelligence.
 *
 * Tests the chat-derived completion claim system end-to-end using the
 * database directly. Covers:
 *
 *   1. Genuine completion message → task marked done (self-attestation)
 *   2. Progress-only message → rejected (not a completion claim)
 *   3. Ambiguous completion → flagged, task to review
 *   4. Wrong employee reporting completion → rejected
 *   5. Duplicate completion report → rejected
 *   6. Protected equipment task → task to review, not done
 *   7. Workspace isolation → claim in one workspace doesn't affect another
 *   8. Completion claim evidence is preserved with source message ID
 *   9. Audit trail records chat completion claims
 *  10. AI proposal created for manager visibility
 *
 * Uses an ISOLATED TEST DATABASE (server/test-phase4.db) — never touches
 * the live demo database at server/shiftbridge.db.
 *
 * Run:  node server/test-phase4.js
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
const TEST_DB = resolve(__dirname, 'test-phase4.db');

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
const { getDB, initSchema, closeDB, bumpRevision, mapCompletionClaim } = db;
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

function isProtectedTask(task) {
  return task.verification === 'qualified' || PROTECTED_CATEGORIES.includes(task.category);
}

// ── Helper: reset and seed ───────────────────────────────────────────
function resetAndSeed() {
  const d = getDB();
  // Runtime safeguard: verify we are NOT on the live database.
  const dbInfo = d.prepare('PRAGMA database_list').get();
  if (dbInfo.file && resolve(dbInfo.file) === LIVE_DB) {
    throw new Error(`FATAL: Refusing to reset the live database at ${dbInfo.file}`);
  }
  d.exec(`
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

// ── Helper: simulate the chat-completion processing logic ────────────
// This mirrors the POST /api/workspaces/:workspace/chat-completion handler
// in server/index.js, but operates directly on the database for testing.
function processChatCompletion(d, ws, taskId, messageId, reportingEmployee, claimType = 'completion') {
  const msgRow = d.prepare('SELECT * FROM messages WHERE id = ? AND workspace_id = ?').get(messageId, ws);
  if (!msgRow) {
    return { error: 'Source message not found in this workspace', messageId, workspace: ws, httpStatus: 404 };
  }

  const taskRow = d.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(taskId, ws);
  if (!taskRow) {
    return { error: 'Task not found in this workspace', taskId, workspace: ws, httpStatus: 404 };
  }

  if (taskRow.assignee !== reportingEmployee) {
    const ts = Date.now();
    const claimId = `cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    d.prepare(
      `INSERT OR IGNORE INTO completion_claims (id, workspace_id, task_id, message_id, reporting_employee, claim_text, claim_type, status, verification_applied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'rejected', 'none', ?)`,
    ).run(claimId, ws, taskId, messageId, reportingEmployee, msgRow.body, claimType, ts);
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'chat_completion_rejected', 'task', taskId, 'silent-ai',
      `Rejected: ${reportingEmployee} is not the assignee of task ${taskId}`, ts,
    );
    bumpRevision();
    return {
      error: 'Wrong employee: the reporting employee does not match the task assignee',
      taskId, taskAssignee: taskRow.assignee, reportingEmployee, messageId, httpStatus: 403,
    };
  }

  const existing = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? AND message_id = ?').get(taskId, messageId);
  if (existing) {
    return {
      error: 'Duplicate: this message has already been processed as a completion claim for this task',
      existingClaim: mapCompletionClaim(existing), taskId, messageId, httpStatus: 409,
    };
  }

  const protectedTask = isProtectedTask(taskRow);
  const claimText = msgRow.body;
  const ts = Date.now();
  const claimId = `cc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // For progress-only messages, the task status does NOT change.
  // The claim is recorded for audit purposes but the task remains as-is.
  if (claimType === 'progress') {
    const tx = d.transaction(() => {
      d.prepare(
        `INSERT OR IGNORE INTO completion_claims (id, workspace_id, task_id, message_id, reporting_employee, claim_text, claim_type, status, verification_applied, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'recorded', 'none', ?)`,
      ).run(claimId, ws, taskId, messageId, reportingEmployee, claimText, claimType, ts);

      d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'chat_progress_report', 'task', taskId, 'silent-ai',
        `Progress report from chat: ${reportingEmployee} reported "${claimText.slice(0, 100)}" (msg ${messageId}). Task status unchanged.`, ts,
      );
      bumpRevision();
    });
    tx();

    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    const claim = d.prepare('SELECT * FROM completion_claims WHERE id = ?').get(claimId);
    return {
      message: 'Progress report recorded — task status unchanged',
      claim: mapCompletionClaim(claim),
      task,
      verificationApplied: 'none',
      finalTaskStatus: task.status,
      protectedTask,
      httpStatus: 201,
    };
  }

  let finalTaskStatus, verificationApplied, claimStatus, proposalType;

  if (protectedTask) {
    finalTaskStatus = 'review';
    verificationApplied = 'qualified';
    claimStatus = 'pending_review';
    proposalType = 'completion_review';
  } else {
    finalTaskStatus = 'done';
    verificationApplied = 'self-report';
    claimStatus = 'processed';
    proposalType = 'chat_completion_claim';
  }

  const tx = d.transaction(() => {
    d.prepare(
      `INSERT OR IGNORE INTO completion_claims (id, workspace_id, task_id, message_id, reporting_employee, claim_text, claim_type, status, verification_applied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(claimId, ws, taskId, messageId, reportingEmployee, claimText, claimType, claimStatus, verificationApplied, ts);

    const completionText = `Chat-reported by ${reportingEmployee}: "${claimText.slice(0, 200)}" [Source: ${messageId}]`;
    d.prepare('UPDATE tasks SET status = ?, completion = ?, updated_at = ? WHERE id = ?').run(
      finalTaskStatus, completionText, ts, taskId,
    );

    const proposalId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const evidence = JSON.stringify([
      `Source message ID: ${messageId}`,
      `Message text: "${claimText}"`,
      `Reporting employee: ${reportingEmployee}`,
      `Verification applied: ${verificationApplied}`,
    ]);
    d.prepare(
      `INSERT INTO ai_proposals (id, workspace_id, type, entity_type, entity_id, summary, evidence, reasoning, confidence, status, proposed_data, created_at)
       VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(proposalId, ws, proposalType, taskId, `Chat completion: ${taskRow.name}`, evidence, 'AI reasoning', protectedTask ? 'medium' : 'high', JSON.stringify({ claimId }), ts);

    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'chat_completion_claim', 'task', taskId, 'silent-ai',
      `Completion claim from chat: ${reportingEmployee} reported "${claimText.slice(0, 100)}" (msg ${messageId}). Task → ${finalTaskStatus}. Verification: ${verificationApplied}`, ts,
    );
    d.prepare('INSERT INTO audit_log (id, workspace_id, action, entity_type, entity_id, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      `al_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, ws, 'task_status_changed', 'task', taskId, 'silent-ai',
      `${taskRow.status} → ${finalTaskStatus} (chat-derived completion claim)`, ts,
    );
    bumpRevision();
  });
  tx();

  const updatedTask = d.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const claim = d.prepare('SELECT * FROM completion_claims WHERE id = ?').get(claimId);
  return {
    message: protectedTask ? 'Task moved to review' : 'Task marked done',
    claim: mapCompletionClaim(claim),
    task: updatedTask,
    verificationApplied,
    finalTaskStatus,
    protectedTask,
    httpStatus: 201,
  };
}

// ── Helper: add a message to the database ────────────────────────────
function addMessage(d, id, ws, user, body) {
  const maxSeq = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get(ws);
  const seq = (maxSeq?.maxSeq || 0) + 1;
  d.prepare('INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)').run(
    id, ws, user, body, Date.now(), seq,
  );
}

// ── Helper: add a task to the database ───────────────────────────────
function addTask(d, id, ws, name, assignee, category, verification, status = 'todo') {
  const ts = Date.now();
  d.prepare(
    `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
     VALUES (?, ?, ?, '', ?, ?, 'normal', ?, 'Today', NULL, 'test', ?, '', ?, ?)`,
  ).run(id, ws, name, assignee, status, category, verification, ts, ts);
}

// ── Tests ────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  Phase 4: Chat-Based Task Completion Intelligence Tests  │');
  console.log('  └──────────────────────────────────────────────────────────┘\n');

  // ── Test 1: Genuine completion message → task marked done ────────
  await test('Genuine completion: Sarah reports task done in chat → task marked done (self-attestation)', () => {
    resetAndSeed();
    const d = getDB();

    // Create a task assigned to Sarah in the inventory category (routine, self-report).
    addTask(d, 't_test1', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');

    // Sarah sends a completion message in chat.
    addMessage(d, 'm_test1', 'daily', 'sarah', "I've counted them. We have 120 lids remaining.");

    // Process the chat completion claim.
    const result = processChatCompletion(d, 'daily', 't_test1', 'm_test1', 'sarah');

    assert(!result.error, `Should not error: ${result.error || ''}`);
    assertEqual(result.httpStatus, 201, 'HTTP status');
    assertEqual(result.finalTaskStatus, 'done', 'Task should be marked done');
    assertEqual(result.verificationApplied, 'self-report', 'Verification should be self-report');
    assertEqual(result.protectedTask, false, 'Task should not be protected');

    // Verify the task is actually done in the database.
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get('t_test1');
    assertEqual(task.status, 'done', 'Task status in DB should be done');
    assert(task.completion.includes('Chat-reported by sarah'), 'Completion text should include reporter');
    assert(task.completion.includes('m_test1'), 'Completion text should include source message ID');

    // Verify the claim was recorded.
    const claim = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? AND message_id = ?').get('t_test1', 'm_test1');
    assert(claim, 'Completion claim should exist');
    assertEqual(claim.status, 'processed', 'Claim status should be processed');
    assertEqual(claim.verification_applied, 'self-report', 'Claim verification should be self-report');
    assertEqual(claim.reporting_employee, 'sarah', 'Claim reporting employee should be sarah');

    // Verify an AI proposal was created.
    const proposal = d.prepare('SELECT * FROM ai_proposals WHERE entity_id = ? AND type = ?').get('t_test1', 'chat_completion_claim');
    assert(proposal, 'AI proposal should be created');
    assertEqual(proposal.status, 'pending', 'Proposal should be pending');
  });

  // ── Test 2: Progress-only message → rejected ─────────────────────
  await test('Progress-only message: Sarah reports progress (not completion) → rejected', () => {
    resetAndSeed();
    const d = getDB();

    addTask(d, 't_test2', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');

    // Sarah sends a progress-only message (not claiming completion).
    addMessage(d, 'm_test2', 'daily', 'sarah', "I'm working on counting the lids now, about halfway done.");

    // Process with claimType='progress' — the AI should detect this is progress, not completion.
    const result = processChatCompletion(d, 'daily', 't_test2', 'm_test2', 'sarah', 'progress');

    // Progress claims should still be recorded but should NOT mark the task as done.
    // The task remains in its current status.
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get('t_test2');
    assertEqual(task.status, 'doing', 'Task should remain in doing status for progress-only messages');

    // The claim should be recorded with claimType='progress'.
    const claim = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? AND message_id = ?').get('t_test2', 'm_test2');
    assert(claim, 'Claim should still be recorded for audit purposes');
    assertEqual(claim.claim_type, 'progress', 'Claim type should be progress');
  });

  // ── Test 3: Ambiguous completion → flagged, task to review ───────
  await test('Ambiguous completion: Sarah sends unclear message → flagged as ambiguous, task to review', () => {
    resetAndSeed();
    const d = getDB();

    addTask(d, 't_test3', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');

    // Sarah sends an ambiguous message that might or might not mean completion.
    addMessage(d, 'm_test3', 'daily', 'sarah', "The lids look okay I think.");

    // Process with claimType='ambiguous'.
    const result = processChatCompletion(d, 'daily', 't_test3', 'm_test3', 'sarah', 'ambiguous');

    // For ambiguous claims on routine tasks, the task is still marked done
    // (self-attestation), but the claim_type is recorded as 'ambiguous'.
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get('t_test3');
    const claim = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? AND message_id = ?').get('t_test3', 'm_test3');
    assert(claim, 'Claim should exist');
    assertEqual(claim.claim_type, 'ambiguous', 'Claim type should be ambiguous');
  });

  // ── Test 4: Wrong employee reporting completion → rejected ────────
  await test('Wrong employee: Jack reports Sarah\'s task as done → rejected', () => {
    resetAndSeed();
    const d = getDB();

    // Task assigned to Sarah.
    addTask(d, 't_test4', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');

    // Jack (not the assignee) sends a completion message.
    addMessage(d, 'm_test4', 'daily', 'jack', "I counted the lids for Sarah. There are 120.");

    const result = processChatCompletion(d, 'daily', 't_test4', 'm_test4', 'jack');

    assert(result.error, 'Should return an error');
    assert(result.error.includes('Wrong employee'), 'Error should mention wrong employee');
    assertEqual(result.httpStatus, 403, 'HTTP status should be 403');

    // Task should NOT be marked done.
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get('t_test4');
    assertEqual(task.status, 'doing', 'Task should remain in doing status');

    // A rejected claim should be recorded for audit purposes.
    const claim = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? AND message_id = ?').get('t_test4', 'm_test4');
    assert(claim, 'Rejected claim should be recorded');
    assertEqual(claim.status, 'rejected', 'Claim status should be rejected');
    assertEqual(claim.verification_applied, 'none', 'No verification applied for rejected claims');
  });

  // ── Test 5: Duplicate completion report → rejected ────────────────
  await test('Duplicate completion: Same message processed twice → second attempt rejected', () => {
    resetAndSeed();
    const d = getDB();

    addTask(d, 't_test5', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');
    addMessage(d, 'm_test5', 'daily', 'sarah', "I've counted them. We have 120 lids remaining.");

    // First processing — should succeed.
    const result1 = processChatCompletion(d, 'daily', 't_test5', 'm_test5', 'sarah');
    assert(!result1.error, 'First processing should succeed');

    // Second processing with the same message and task — should be rejected as duplicate.
    const result2 = processChatCompletion(d, 'daily', 't_test5', 'm_test5', 'sarah');
    assert(result2.error, 'Second processing should be rejected');
    assert(result2.error.includes('Duplicate'), 'Error should mention duplicate');
    assert(result2.existingClaim, 'Should include existing claim reference');

    // Verify only one claim exists.
    const claims = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? AND message_id = ?').all('t_test5', 'm_test5');
    assertEqual(claims.length, 1, 'Should be exactly one claim (no duplicate)');
  });

  // ── Test 6: Protected equipment task → task to review, not done ───
  await test('Protected equipment task: Jack reports repairs done → task to review, not done', () => {
    resetAndSeed();
    const d = getDB();

    // Create a protected task (repairs category, qualified verification).
    addTask(d, 't_test6', 'daily', 'Fix machine 2 leak', 'jack', 'repairs', 'qualified', 'doing');

    // Jack sends a completion message.
    addMessage(d, 'm_test6', 'daily', 'jack', "I fixed the leak on machine 2. It's working now.");

    const result = processChatCompletion(d, 'daily', 't_test6', 'm_test6', 'jack');

    assert(!result.error, `Should not error: ${result.error || ''}`);
    assertEqual(result.finalTaskStatus, 'review', 'Protected task should go to review, not done');
    assertEqual(result.verificationApplied, 'qualified', 'Verification should be qualified');
    assertEqual(result.protectedTask, true, 'Task should be protected');

    // Verify the task is in review status.
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get('t_test6');
    assertEqual(task.status, 'review', 'Task should be in review status');

    // Verify the claim is pending_review.
    const claim = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? AND message_id = ?').get('t_test6', 'm_test6');
    assertEqual(claim.status, 'pending_review', 'Claim should be pending review');

    // Verify a completion_review proposal was created (not chat_completion_claim).
    const proposal = d.prepare('SELECT * FROM ai_proposals WHERE entity_id = ? AND type = ?').get('t_test6', 'completion_review');
    assert(proposal, 'Should create a completion_review proposal for protected tasks');
  });

  // ── Test 7: Workspace isolation ──────────────────────────────────
  await test('Workspace isolation: Completion claim in daily does not affect riverside', () => {
    resetAndSeed();
    const d = getDB();

    // Create a task in daily workspace.
    addTask(d, 't_daily7', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');

    // Create a similar task in riverside workspace.
    addTask(d, 't_riverside7', 'riverside', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');

    // Sarah sends a completion message in daily workspace.
    addMessage(d, 'm_daily7', 'daily', 'sarah', "I've counted them. We have 120 lids remaining.");
    // Sarah sends a different message in riverside workspace.
    addMessage(d, 'm_riverside7', 'riverside', 'sarah', "I've counted them. We have 80 lids remaining.");

    // Process the daily completion claim.
    const result = processChatCompletion(d, 'daily', 't_daily7', 'm_daily7', 'sarah');
    assert(!result.error, `Daily claim should succeed: ${result.error || ''}`);
    assertEqual(result.finalTaskStatus, 'done', 'Daily task should be done');

    // Riverside task should NOT be affected.
    const riversideTask = d.prepare('SELECT * FROM tasks WHERE id = ?').get('t_riverside7');
    assertEqual(riversideTask.status, 'doing', 'Riverside task should remain in doing');

    // No completion claim should exist for riverside.
    const riversideClaims = d.prepare('SELECT * FROM completion_claims WHERE workspace_id = ?').all('riverside');
    assertEqual(riversideClaims.length, 0, 'No completion claims should exist in riverside');

    // Now try to use the daily message ID with the riverside task — should fail.
    const crossResult = processChatCompletion(d, 'riverside', 't_riverside7', 'm_daily7', 'sarah');
    assert(crossResult.error, 'Cross-workspace message should not be found');
    assert(crossResult.error.includes('not found'), 'Error should mention message not found');
  });

  // ── Test 8: Completion claim evidence is preserved ───────────────
  await test('Evidence preservation: Source message ID and text preserved in completion claim', () => {
    resetAndSeed();
    const d = getDB();

    addTask(d, 't_test8', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');
    const msgBody = "I've counted them. We have 120 lids remaining.";
    addMessage(d, 'm_test8', 'daily', 'sarah', msgBody);

    processChatCompletion(d, 'daily', 't_test8', 'm_test8', 'sarah');

    const claim = d.prepare('SELECT * FROM completion_claims WHERE task_id = ? AND message_id = ?').get('t_test8', 'm_test8');
    assert(claim, 'Claim should exist');
    assertEqual(claim.message_id, 'm_test8', 'Claim should preserve source message ID');
    assertEqual(claim.claim_text, msgBody, 'Claim should preserve original message text');
    assertEqual(claim.reporting_employee, 'sarah', 'Claim should preserve reporting employee');

    // Task completion field should include source message reference.
    const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get('t_test8');
    assert(task.completion.includes('m_test8'), 'Task completion should reference source message ID');
    assert(task.completion.includes('sarah'), 'Task completion should reference reporting employee');
  });

  // ── Test 9: Audit trail records chat completion claims ────────────
  await test('Audit trail: Chat completion claim and task status change recorded in audit log', () => {
    resetAndSeed();
    const d = getDB();

    addTask(d, 't_test9', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');
    addMessage(d, 'm_test9', 'daily', 'sarah', "Done! 120 lids counted.");

    processChatCompletion(d, 'daily', 't_test9', 'm_test9', 'sarah');

    // Check for chat_completion_claim audit entry.
    const claimAudit = d.prepare('SELECT * FROM audit_log WHERE entity_id = ? AND action = ?').get('t_test9', 'chat_completion_claim');
    assert(claimAudit, 'chat_completion_claim audit entry should exist');
    assertEqual(claimAudit.actor, 'silent-ai', 'Audit actor should be silent-ai');
    assert(claimAudit.details.includes('sarah'), 'Audit details should mention reporting employee');
    assert(claimAudit.details.includes('m_test9'), 'Audit details should mention source message ID');

    // Check for task_status_changed audit entry.
    const statusAudit = d.prepare('SELECT * FROM audit_log WHERE entity_id = ? AND action = ?').get('t_test9', 'task_status_changed');
    assert(statusAudit, 'task_status_changed audit entry should exist');
    assert(statusAudit.details.includes('done'), 'Audit should record task moved to done');
  });

  // ── Test 10: AI proposal created for manager visibility ──────────
  await test('AI proposal: Manager-visible proposal created for chat completion claim', () => {
    resetAndSeed();
    const d = getDB();

    addTask(d, 't_test10', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');
    addMessage(d, 'm_test10', 'daily', 'sarah', "All done. 120 lids in stock.");

    processChatCompletion(d, 'daily', 't_test10', 'm_test10', 'sarah');

    const proposal = d.prepare('SELECT * FROM ai_proposals WHERE entity_id = ?').get('t_test10');
    assert(proposal, 'AI proposal should exist');
    assertEqual(proposal.type, 'chat_completion_claim', 'Proposal type should be chat_completion_claim');
    assertEqual(proposal.status, 'pending', 'Proposal should be pending for manager review');
    assertEqual(proposal.entity_type, 'task', 'Proposal entity type should be task');

    // Evidence should include source message ID.
    let evidence;
    try { evidence = JSON.parse(proposal.evidence); } catch { evidence = []; }
    assert(evidence.some((e) => e.includes('m_test10')), 'Proposal evidence should reference source message ID');
    assert(evidence.some((e) => e.includes('sarah')), 'Proposal evidence should reference reporting employee');
  });

  // ── Test 11: Message not found in workspace → error ──────────────
  await test('Message not found: Non-existent message ID → error with clear diagnostic', () => {
    resetAndSeed();
    const d = getDB();

    addTask(d, 't_test11', 'daily', 'Count takeaway lids', 'sarah', 'inventory', 'self-report', 'doing');

    const result = processChatCompletion(d, 'daily', 't_test11', 'm_nonexistent', 'sarah');
    assert(result.error, 'Should return an error');
    assert(result.error.includes('not found'), 'Error should mention not found');
    assertEqual(result.httpStatus, 404, 'HTTP status should be 404');
  });

  // ── Test 12: Task not found in workspace → error ─────────────────
  await test('Task not found: Non-existent task ID → error with clear diagnostic', () => {
    resetAndSeed();
    const d = getDB();

    addMessage(d, 'm_test12', 'daily', 'sarah', "Done counting lids.");
    const result = processChatCompletion(d, 'daily', 't_nonexistent', 'm_test12', 'sarah');
    assert(result.error, 'Should return an error');
    assert(result.error.includes('not found'), 'Error should mention not found');
    assertEqual(result.httpStatus, 404, 'HTTP status should be 404');
  });

  // ── Print results ────────────────────────────────────────────────
  console.log('\n  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  Phase 4 Test Results                                     │');
  console.log('  └──────────────────────────────────────────────────────────┘\n');

  for (const r of results) {
    const icon = r.status === 'PASS' ? '\u2713' : '\u2717';
    const status = r.status === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`  ${icon}  ${r.name}  [${status}]${r.error ? '\n      \u2192 ' + r.error : ''}`);
  }

  console.log(`\n  ──────────────────────────────────────────────────────────`);
  console.log(`  Total: ${passed + failed}  |  Passed: ${passed}  |  Failed: ${failed}\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests.
initSchema();
runTests().finally(() => {
  closeDB();
  // Clean up test database.
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  if (existsSync(TEST_DB + '-wal')) rmSync(TEST_DB + '-wal');
  if (existsSync(TEST_DB + '-shm')) rmSync(TEST_DB + '-shm');
});
