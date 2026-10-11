/**
 * Tencent adapter unit tests. These are NOT end-to-end AI tests.
 *
 * Safe by default: no backend on port 3000, live SQLite database, gateway,
 * CodeBuddy account, or MCP server is accessed.
 *
 * The previous "integration" tests wrote to the running demo database and
 * submitted fabricated successful actions to /api/tencent/jobs/:id/complete.
 * Those tests could pass without the agent creating a real task.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStreamJsonOutput,
  validateAgentEvidence,
  nextAttempt,
  buildIsolatedMcpConfig,
} from './tencent-agent.js';

const callId = 'toolu_shiftbridge_read_1';
function output({ toolName = 'mcp__shiftbridge__get_active_tasks', includeCall = true,
  includeResult = true, error = false, final = 'success' } = {}) {
  const events = [];
  if (includeCall) {
    events.push({ type: 'assistant', message: {
      content: [{ type: 'tool_use', id: callId, name: toolName, input: { workspace: 'daily' } }],
    } });
  }
  if (includeResult) {
    events.push({ type: 'user', message: {
      content: [{
        type: 'tool_result', tool_use_id: callId, is_error: error,
        content: [{ type: 'text', text: JSON.stringify(error
          ? { error: 'policy rejected' }
          : { tasks: [{ id: 't1', status: 'todo' }] }) }],
      }],
    } });
  }
  if (final) events.push({ type: 'result', subtype: final, result: 'Completed' });
  return events.map(obj => JSON.stringify(obj)).join('\n');
}

test('records an actual structured MCP tool_use event', () => {
  const parsed = parseStreamJsonOutput(output());
  assert.equal(parsed.toolCalls[0].name, 'mcp__shiftbridge__get_active_tasks');
  assert.deepEqual(parsed.toolCalls[0].input, { workspace: 'daily' });
  assert.equal(parsed.toolResults[0].ok, true);
  assert.equal(validateAgentEvidence(parsed).length, 1);
});

test('plain text containing tool-call markup is not real MCP execution', () => {
  const out = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text',
      text: 'I will now call <tool_call>TaskList' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'Done' }),
  ].join('\n');
  assert.throws(() => validateAgentEvidence(parseStreamJsonOutput(out)), /no executed ShiftBridge MCP/);
});

test('a tool_use event without corresponding tool_result is not completion', () => {
  assert.throws(() => validateAgentEvidence(parseStreamJsonOutput(output({ includeResult: false }))),
    /Missing successful tool_result/);
});

test('MCP is_error rejects agent run', () => {
  assert.throws(() => validateAgentEvidence(parseStreamJsonOutput(output({ error: true }))),
    /MCP tool execution failed/);
});

test('error JSON embedded in tool text rejects agent run', () => {
  const parsed = parseStreamJsonOutput(output({ error: true }).replace('"is_error":true', '"is_error":false'));
  assert.equal(parsed.toolErrors.length, 1);
  assert.throws(() => validateAgentEvidence(parsed), /MCP tool execution failed/);
});

test('non-MCP built-in tools do not count as ShiftBridge execution', () => {
  assert.throws(() => validateAgentEvidence(parseStreamJsonOutput(output({ toolName: 'TaskList' }))),
    /no executed ShiftBridge MCP/);
});

test('missing final agent result fails closed', () => {
  assert.throws(() => validateAgentEvidence(parseStreamJsonOutput(output({ final: null }))),
    /successful final result/);
});

test('failed final agent result fails closed even with successful tool', () => {
  assert.throws(() => validateAgentEvidence(parseStreamJsonOutput(output({ final: 'error' }))),
    /successful final result/);
});

test('retry attempts increase exactly once per attempt', () => {
  assert.equal(nextAttempt(0, 3), 1);
  assert.equal(nextAttempt(1, 3), 2);
  assert.equal(nextAttempt(2, 3), 3);
});

test('retry cannot exceed maximum', () => {
  assert.throws(() => nextAttempt(3, 3), /retry limit/i);
});

// Real CodeBuddy → MCP → task creation must be tested separately in an
// isolated runtime. No fabricated success marker is accepted as an E2E test.

test('isolated CLI config binds MCP to exactly the selected backend', () => {
  const config = buildIsolatedMcpConfig(
    'http://127.0.0.1:3001/api',
    'http://127.0.0.1:3001/api',
    '/usr/bin/node',
    '/tmp/shiftbridge/server/mcp-server.js',
  );
  assert.equal(config.mcpServers.shiftbridge.env.SHIFTBRIDGE_API, 'http://127.0.0.1:3001/api');
  assert.equal(config.mcpServers.shiftbridge.defer_loading, false);
  assert.equal(Object.keys(config.mcpServers).length, 1);
});

test('isolated CLI config rejects mismatched backend ports and non-local targets', () => {
  assert.throws(() => buildIsolatedMcpConfig(
    'http://127.0.0.1:3000/api', 'http://127.0.0.1:3001/api', 'node', 'mcp-server.js',
  ), /must exactly match/);
  assert.throws(() => buildIsolatedMcpConfig(
    'https://example.com/api', 'https://example.com/api', 'node', 'mcp-server.js',
  ), /Isolated MCP target/);
});
