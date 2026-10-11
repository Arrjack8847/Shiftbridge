/**
 * server/tencent-agent.js — ShiftBridge Tencent AI Agent
 *
 * Event-driven AI processing for ShiftBridge using genuine Tencent AI.
 * When AI_PROVIDER=tencent-local is set, this module replaces the Groq agent.
 *
 * Architecture:
 *   1. New message saved → createJob() in ai_jobs table (same as Groq)
 *   2. setImmediate → processMessage() fires async (non-blocking)
 *   3. processMessage() triggers CodeBuddy agent via one of two modes:
 *      a) "serve" mode (default): HTTP API (POST /api/v1/runs) to a running
 *         `codebuddy --serve` instance on port 8080
 *      b) "cli" mode: Spawns `codebuddy -p` as a child process with
 *         controlled env vars and restricted MCP permissions
 *   4. CodeBuddy agent processes using MCP tools (get_workspace_rules,
 *      get_active_tasks, get_recent_messages, create_manager_task, etc.)
 *   5. Adapter marks job completed/failed, logs to ai_analysis_log
 *   6. If CodeBuddy is not available, job stays pending for hourly recovery
 *
 * Configuration:
 *   CODEBUDDY_EXECUTION_MODE — "serve" (default) or "cli"
 *   CODEBUDDY_SERVE_URL — Serve mode only. Default: http://127.0.0.1:8080
 *   CODEBUDDY_GATEWAY_PASSWORD — Serve mode. Gateway auth password.
 *   CODEBUDDY_CLI_PATH — CLI mode. Path to codebuddy binary.
 *     Default: "codebuddy" (looked up in PATH)
 *   CODEBUDDY_CLI_TIMEOUT_MS — CLI mode. Default: 120000 (2 min)
 *   CODEBUDDY_DEFER_TOOL_LOADING — CLI mode. Set to "false" to make
 *     MCP tools non-deferred (directly in model's tool list)
 *   AI_PROVIDER — Set to "tencent-local" to enable (default), "groq" to disable
 *
 * CLI mode safety:
 *   - NODE_OPTIONS is cleared to avoid the WorkBuddy shim interfering
 *     with the global npm CodeBuddy binary's axios proxy setup
 *   - --permission-mode dontAsk prevents interactive prompts
 *   - --allowedTools restricts to ShiftBridge MCP tools + Read/Grep
 *   - --disallowedTools blocks Bash, Edit, Write, PowerShell
 *   - --max-turns limits agent execution depth
 *   - Timeout kills the process if it runs too long
 *   - The MCP server config in mcp-shiftbridge-only.json has defer_loading: false
 *
 * Serve mode safety:
 *   - The serve instance should be started with --permission-mode dontAsk
 *   - CODEBUDDY_DEFER_TOOL_LOADING=false makes MCP tools non-deferred
 *
 * Safety:
 *   - The system prompt enforces workspace rules and protected categories
 *   - The AI uses MCP tools which apply server-side validation
 *   - The AI NEVER posts to chat directly
 *   - All actions go through the existing API endpoints
 *
 * Reliability:
 *   - Failed jobs stay in the ai_jobs table for retry
 *   - The hourly automation can call processPendingJobs() as recovery
 *   - Max 3 retry attempts per job
 *   - Never resets the database
 */

import { getDB, bumpRevision } from './db.js';
import { spawn } from 'node:child_process';

const CODEBUDDY_SERVE_URL = process.env.CODEBUDDY_SERVE_URL || 'http://127.0.0.1:8080';
const CODEBUDDY_GATEWAY_PASSWORD = process.env.CODEBUDDY_GATEWAY_PASSWORD || '';
const SHIFTBRIDGE_API = process.env.SHIFTBRIDGE_API || 'http://localhost:3000/api';
const TENCENT_ENABLED = process.env.AI_PROVIDER !== 'groq'; // Enabled by default
const MAX_ATTEMPTS = 3;
const RUN_TIMEOUT_MS = 60000; // 60 second timeout for CodeBuddy serve runs
const POLL_INTERVAL_MS = 3000; // Poll every 3 seconds

// CLI mode configuration
const EXECUTION_MODE = process.env.CODEBUDDY_EXECUTION_MODE || 'serve'; // 'serve' or 'cli'
const CODEBUDDY_CLI_PATH = process.env.CODEBUDDY_CLI_PATH || 'codebuddy';
const CODEBUDDY_CLI_TIMEOUT_MS = parseInt(process.env.CODEBUDDY_CLI_TIMEOUT_MS || '120000', 10);
const CODEBUDDY_CLI_MAX_TURNS = parseInt(process.env.CODEBUDDY_CLI_MAX_TURNS || '5', 10);
// Read-only tools for TEST 1; write tools can be added for TEST 2
const CODEBUDDY_CLI_ALLOWED_TOOLS = process.env.CODEBUDDY_CLI_ALLOWED_TOOLS ||
  'mcp__shiftbridge__get_active_tasks,mcp__shiftbridge__get_workspace_rules,mcp__shiftbridge__get_recent_messages,mcp__shiftbridge__list_tasks,mcp__shiftbridge__get_audit_trail,Read,Grep,Glob';
const CODEBUDDY_CLI_DISALLOWED_TOOLS = process.env.CODEBUDDY_CLI_DISALLOWED_TOOLS ||
  'Bash,Edit,Write,PowerShell,TaskCreate,TaskUpdate,TaskDelete';

// Common headers for all CodeBuddy Serve API requests
function serveHeaders(extra = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-CodeBuddy-Request': '1',
  };
  if (CODEBUDDY_GATEWAY_PASSWORD) {
    headers['Authorization'] = `Bearer ${CODEBUDDY_GATEWAY_PASSWORD}`;
  }
  return { ...headers, ...extra };
}

// Track in-flight jobs to prevent concurrent processing
const inFlight = new Set();

// ─── HTTP helpers ─────────────────────────────────────────────────
async function apiGet(path) {
  const res = await fetch(`${SHIFTBRIDGE_API}${path}`);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function apiPost(path, body) {
  const res = await fetch(`${SHIFTBRIDGE_API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  return { ok: res.ok, json };
}

// ─── Check if CodeBuddy serve is available ───────────────────────
let serveAvailable = null;
let serveCheckedAt = 0;

async function checkServeAvailable() {
  // Cache for 30 seconds
  if (serveAvailable !== null && Date.now() - serveCheckedAt < 30000) {
    return serveAvailable;
  }
  try {
    const res = await fetch(`${CODEBUDDY_SERVE_URL}/api/v1/health`, {
      headers: serveHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    serveAvailable = res.ok;
  } catch {
    serveAvailable = false;
  }
  serveCheckedAt = Date.now();
  return serveAvailable;
}

// ─── Build the prompt for CodeBuddy agent ─────────────────────────
function buildAgentPrompt(workspaceId, messageId, messageUser, messageBody, context) {
  const { rules, tasks, messages, people } = context;

  const peopleList = people.map(p => `${p.id} (${p.name}, ${p.role})`).join(', ');
  const rulesList = rules.map(r =>
    `- ${r.id}: "${r.name}" — ${r.note} | allowed: ${r.allowed}${r.locked ? ' (LOCKED — requires qualified verification)' : ''}`
  ).join('\n');
  const tasksList = tasks.map(t =>
    `- ${t.id}: "${t.name}" | status: ${t.status} | assignee: ${t.assignee || 'unassigned'} | category: ${t.category || 'routine'}`
  ).join('\n');
  const messagesText = messages.slice(-10).map(m => {
    const person = people.find(p => p.id === m.user) || {};
    return `[${m.seq}] ${person.name || m.user} (${person.role || 'unknown'}): "${m.body}" (id: ${m.id})`;
  }).join('\n');

  return `You are ShiftBridge AI, an intelligent assistant for a small-business shift management platform.

## Your Role
You analyze chat messages from team members and take appropriate actions using the ShiftBridge MCP tools. You NEVER post messages to the chat yourself. You only CREATE TASKS, PROPOSE COMPLETIONS, REPORT ISSUES, and DRAFT ANNOUNCEMENTS via MCP tools.

## Team Members
${peopleList}

## Workspace Rules (Safety Constraints)
${rulesList}

## CRITICAL SAFETY RULES
1. **Protected categories** (repairs, purchases, safety) are LOCKED and require qualified human verification. You may NOT auto-approve or auto-complete tasks in these categories.
2. **Permissions**: Only the workspace manager (admin role) can create tasks directly. Employees can report issues and claim task completion.
3. **No duplicate actions**: If a task already exists for a message, do not create another.
4. **You do not post to chat**: You only use MCP tools to take actions.

## Current Active Tasks
${tasksList || '(no active tasks)'}

## Recent Chat Messages
${messagesText || '(no messages)'}

## NEW MESSAGE TO ANALYZE
From: ${messageUser}
Body: "${messageBody}"
Message ID: ${messageId}

## Instructions
1. Call get_workspace_rules for workspace "${workspaceId}" to confirm the rules
2. Call get_active_tasks for workspace "${workspaceId}" to check for duplicates
3. Analyze the NEW MESSAGE above and determine what actions should be taken
4. Execute actions using MCP tools:
   - If a manager gives an instruction in an allowed category (inventory, cleaning, opening): call create_manager_task
   - If an employee reports completing a task: call propose_completion
   - If an employee reports a problem: call propose_chat_completion with report_issue type (or use the report-issue API)
   - If an announcement is warranted: call propose_announcement_draft
5. Report what you did in a brief summary

Be concise and take real actions via MCP tools. Do not just describe what you would do — actually call the tools.`;
}

// ─── Trigger CodeBuddy serve to process a message ─────────────────
async function triggerCodeBuddyServe(workspaceId, messageId, messageUser, messageBody, context) {
  const prompt = buildAgentPrompt(workspaceId, messageId, messageUser, messageBody, context);
  const runId = `sb-tencent-${messageId}-${Date.now()}`;

  // POST /api/v1/runs — Gateway Protocol format
  const runRes = await fetch(`${CODEBUDDY_SERVE_URL}/api/v1/runs`, {
    method: 'POST',
    headers: serveHeaders(),
    body: JSON.stringify({
      id: runId,
      type: 'message',
      source: {
        platform: 'generic',
        sender: { id: 'shiftbridge', name: 'ShiftBridge' },
        conversation: { id: runId, type: 'direct' },
      },
      payload: { text: prompt },
      timeoutMs: RUN_TIMEOUT_MS,
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!runRes.ok) {
    const errText = await runRes.text().catch(() => '');
    throw new Error(`CodeBuddy serve ${runRes.status}: ${errText.slice(0, 300)}`);
  }

  const runData = await runRes.json();
  const actualRunId = runData.data?.runId;
  if (!actualRunId) {
    throw new Error('CodeBuddy serve did not return a runId');
  }

  // Poll for completion
  const pollStart = Date.now();
  while (Date.now() - pollStart < RUN_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const statusRes = await fetch(
      `${CODEBUDDY_SERVE_URL}/api/v1/runs/${actualRunId}`,
      { headers: serveHeaders() },
    );
    const statusData = await statusRes.json();
    const active = statusData.data?.active;

    if (active === false) {
      // Run completed — try to get the transcript from jobs if available
      return {
        runId: actualRunId,
        completed: true,
        latency: Date.now() - pollStart,
      };
    }
  }

  // Timed out
  throw new Error(`CodeBuddy run ${actualRunId} timed out after ${RUN_TIMEOUT_MS}ms`);
}

// ─── Parse CodeBuddy stream-json output ──────────────────────────
function parseStreamJsonOutput(stdout) {
  const lines = stdout.trim().split('\n');
  let text = '';
  const toolCalls = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      // stream-json format: each line is a JSON object with a "type" field
      if (obj.type === 'assistant' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text') {
            text += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({ name: block.name, input: block.input });
          }
        }
      } else if (obj.type === 'result') {
        // Final result line — may contain the summary text
        if (obj.subtype === 'success' && obj.result) {
          text = text || obj.result;
        }
      }
    } catch {
      // Skip non-JSON lines (e.g., "fetch config failed" warnings)
    }
  }

  return { text, toolCalls };
}

// ─── Trigger CodeBuddy CLI to process a message ──────────────────
async function triggerCodeBuddyCLI(workspaceId, messageId, messageUser, messageBody, context) {
  const prompt = buildAgentPrompt(workspaceId, messageId, messageUser, messageBody, context);
  const startTime = Date.now();

  // Build a clean environment for the child process that replicates the
  // external PowerShell environment where `codebuddy -p` is verified working.
  //
  // The WorkBuddy desktop injects several env vars that break the global npm
  // CodeBuddy binary:
  //   NODE_OPTIONS=--require=".../node-language-shim.cjs"
  //     → The shim breaks axios proxy setup ("instanceof is not callable")
  //   CODEBUDDY_FORCE_LITE_WB_BUNDLE=1
  //     → Forces the lite WB bundle (codebuddy-lite-wb.mjs) which has the
  //       setProxy TypeError; the default bundle doesn't have this issue
  //   CODEBUDDY_FORCE_HEADLESS_BUNDLE=1
  //     → Forces the headless bundle variant
  //   CODEBUDDY_MCP_CONFIG={...}
  //     → Contains shiftbridge WITHOUT defer_loading:false; the file-based
  //       config at ~/.codebuddy/.mcp.json has defer_loading:false
  //   CODEBUDDY_CONFIG_DIR=.../.workbuddy-ai
  //     → Points to WorkBuddy's config; external PowerShell uses ~/.codebuddy
  //   CODEBUDDY_HOST=workbuddy-desktop
  //     → Identifies as WorkBuddy desktop, triggers different code paths
  //
  // By deleting these vars, the child process uses the same configuration
  // as the external PowerShell: default config dir (~/.codebuddy), file-based
  // MCP config (with defer_loading:false), and the standard CodeBuddy bundle.
  const childEnv = { ...process.env };

  // Delete WorkBuddy-specific env vars to replicate external PowerShell
  delete childEnv.NODE_OPTIONS;
  delete childEnv.CODEBUDDY_FORCE_LITE_WB_BUNDLE;
  delete childEnv.CODEBUDDY_FORCE_HEADLESS_BUNDLE;
  delete childEnv.CODEBUDDY_MCP_CONFIG;
  delete childEnv.CODEBUDDY_HOST;
  delete childEnv.CODEBUDDY_CONFIG_DIR;
  // CODEBUDDY_SERVICE_PROXY_URL points to the WorkBuddy daemon's port (64580).
  // The CLI tries to listen on this port, causing EADDRINUSE since the daemon
  // is already running. External PowerShell doesn't have this var.
  delete childEnv.CODEBUDDY_SERVICE_PROXY_URL;
  // Clear WorkBuddy safe-delete vars (they reference desktop-specific paths)
  delete childEnv.CODEBUDDY_SAFE_DELETE_BIN_DIR;
  delete childEnv.CODEBUDDY_SAFE_DELETE_BROKER_DELETE;
  delete childEnv.CODEBUDDY_SAFE_DELETE_BULK_GUARD;
  delete childEnv.CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR;
  delete childEnv.CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD;
  delete childEnv.CODEBUDDY_SAFE_DELETE_ENABLED;
  delete childEnv.CODEBUDDY_SAFE_DELETE_REPORT_PATH;
  delete childEnv.CODEBUDDY_SAFE_DELETE_SANDBOX;
  // Clear sandbox IPC (desktop-specific)
  delete childEnv.SANDBOX_CENTER_IPC_ADDRESS;

  // Set deferred loading to false as a safety net (the file-based MCP config
  // already has defer_loading:false, but this covers any other MCP servers)
  childEnv.CODEBUDDY_DEFER_TOOL_LOADING = 'false';

  // On Windows, the `codebuddy` command is a .cmd wrapper that calls:
  //   node "C:\...\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy" %*
  // We can't use spawn() without shell:true for .cmd files, and shell:true
  // would re-introduce quoting issues with the long prompt. Instead, we
  // call node.exe directly with the JS entry point as the first argument.
  // This is the same approach the .cmd wrapper uses, just without the shell.
  const nodeBin = process.env.CODEBUDDY_NODE_BIN || process.execPath;
  // Resolve the CodeBuddy JS entry point from the global npm install.
  // The path is: <npm-global>/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy
  // CODEBUDDY_CLI_SCRIPT can override this if needed.
  const codebuddyScript = process.env.CODEBUDDY_CLI_SCRIPT ||
    'C:\\Users\\ASUS\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy';

  // Build CLI arguments (the JS entry point is the first arg to node)
  const args = [
    codebuddyScript,
    '-p', prompt,                         // Positional prompt (primary input)
    '--max-turns', String(CODEBUDDY_CLI_MAX_TURNS),
    '--permission-mode', 'dontAsk',
    '--allowedTools', CODEBUDDY_CLI_ALLOWED_TOOLS,
    '--disallowedTools', CODEBUDDY_CLI_DISALLOWED_TOOLS,
    '--output-format', 'stream-json',
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, args, {
      env: childEnv,
      shell: false,       // Direct execution, no shell quoting issues
      windowsHide: true,
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Timeout: kill the process if it runs too long
    const timeoutHandle = setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGTERM');
        // Give it 5 seconds to clean up, then force kill
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 5000);
      }
    }, CODEBUDDY_CLI_TIMEOUT_MS);

    child.on('close', (code, signal) => {
      clearTimeout(timeoutHandle);

      if (signal === 'SIGTERM' || signal === 'SIGKILL') {
        reject(new Error(`CodeBuddy CLI timed out after ${CODEBUDDY_CLI_TIMEOUT_MS}ms`));
        return;
      }

      if (code !== 0) {
        const errSnippet = stderr.slice(0, 500) || stdout.slice(0, 500);
        reject(new Error(`CodeBuddy CLI exited with code ${code}: ${errSnippet}`));
        return;
      }

      // Parse the stream-json output
      const result = parseStreamJsonOutput(stdout);
      const latency = Date.now() - startTime;

      resolve({
        runId: `cli-${messageId}-${Date.now()}`,
        completed: true,
        latency,
        output: result.text,
        toolCalls: result.toolCalls,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to spawn CodeBuddy CLI (${nodeBin} ${codebuddyScript}): ${err.message}`));
    });
  });
}

// ─── Create a job in the ai_jobs table ────────────────────────────
function createJob(workspaceId, messageId) {
  const d = getDB();
  const ts = Date.now();

  // Check for existing job first (unique index on message_id)
  const existing = d.prepare('SELECT id FROM ai_jobs WHERE message_id = ?').get(messageId);
  if (existing) return existing.id;

  const jobId = `aj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  d.prepare(
    `INSERT OR IGNORE INTO ai_jobs (id, workspace_id, message_id, status, attempts, max_attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
  ).run(jobId, workspaceId, messageId, MAX_ATTEMPTS, ts, ts);
  return jobId;
}

// ─── Update job status ────────────────────────────────────────────
function updateJob(jobId, updates) {
  const d = getDB();
  const ts = Date.now();
  const setClauses = ['updated_at = ?'];
  const params = [ts];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      params.push(value);
    }
  }
  params.push(jobId);
  d.prepare(`UPDATE ai_jobs SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
}

// ─── Fetch workspace context ──────────────────────────────────────
async function fetchContext(workspaceId) {
  const [peopleRes, workspacesRes, messagesRes, tasksRes] = await Promise.all([
    apiGet('/people'),
    apiGet('/workspaces'),
    apiGet(`/workspaces/${workspaceId}/messages?limit=20`),
    apiGet(`/workspaces/${workspaceId}/tasks`),
  ]);

  const ws = workspacesRes.workspaces?.find(w => w.id === workspaceId);
  const rules = ws?.rules || [];
  const messages = messagesRes.messages || [];
  const tasks = (tasksRes.tasks || []).filter(t => t.status !== 'done');
  const people = peopleRes || [];

  return { rules, tasks, messages, people };
}

// ─── Main: process a single message ───────────────────────────────
export async function processMessage(workspaceId, messageId, messageUser, messageBody) {
  // Always create a job record first
  const jobId = createJob(workspaceId, messageId);

  if (!TENCENT_ENABLED) {
    updateJob(jobId, { status: 'pending', last_error: 'Tencent AI disabled (AI_PROVIDER=groq)' });
    return { skipped: true, reason: 'Tencent AI disabled', jobId };
  }

  // Prevent concurrent processing
  if (inFlight.has(messageId)) {
    return { skipped: true, reason: 'Already processing this message' };
  }
  inFlight.add(messageId);

  const startTime = Date.now();

  try {
    // For CLI mode, skip the serve availability check
    const useCli = EXECUTION_MODE === 'cli';

    if (!useCli) {
      // Serve mode: check if CodeBuddy serve is available
      const serveOk = await checkServeAvailable();

      if (!serveOk) {
        // CodeBuddy serve not available — job stays pending for hourly automation
        updateJob(jobId, {
          status: 'pending',
          last_error: 'CodeBuddy serve not available — will be processed by hourly automation',
        });
        return {
          ok: false,
          skipped: true,
          reason: 'CodeBuddy serve not available — pending for automation recovery',
          jobId,
          willRetry: true,
        };
      }
    }

    // Update job to processing
    updateJob(jobId, { status: 'processing', attempts: 1, model_used: 'tencent-codebuddy' });

    // Fetch workspace context
    const context = await fetchContext(workspaceId);

    // Trigger CodeBuddy to process the message (serve or CLI mode)
    const result = useCli
      ? await triggerCodeBuddyCLI(workspaceId, messageId, messageUser, messageBody, context)
      : await triggerCodeBuddyServe(workspaceId, messageId, messageUser, messageBody, context);

    const totalLatency = Date.now() - startTime;
    const ts = Date.now();

    // Build summary including tool calls if available (CLI mode)
    const toolCallSummary = result.toolCalls && result.toolCalls.length > 0
      ? ` Tools called: ${result.toolCalls.map(t => t.name).join(', ')}.`
      : '';
    const outputSummary = result.output ? ` Output: ${result.output.slice(0, 200)}` : '';

    // Log to ai_analysis_log
    const logId = `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const d = getDB();
    d.prepare(
      `INSERT INTO ai_analysis_log (id, workspace_id, run_at, messages_total, messages_new, proposals_created, completion_claims, errors, last_message_seq, status, summary, created_at)
       VALUES (?, ?, ?, ?, 1, 0, 0, '', ?, 'success', ?, ?)`,
    ).run(
      logId, workspaceId, ts, context.messages.length,
      context.messages.length > 0 ? context.messages[context.messages.length - 1].seq : 0,
      `Tencent AI (${useCli ? 'CLI' : 'Serve'}): Run ${result.runId} completed in ${result.latency}ms.${toolCallSummary}${outputSummary}`,
      ts,
    );

    bumpRevision();

    // Update job to completed
    updateJob(jobId, {
      status: 'completed',
      last_error: '',
      actions_json: JSON.stringify({
        runId: result.runId,
        agent: 'tencent-codebuddy',
        mode: useCli ? 'cli' : 'serve',
        toolCalls: result.toolCalls || [],
        output: result.output || '',
      }),
      latency_ms: totalLatency,
      model_used: 'tencent-codebuddy',
      completed_at: ts,
    });

    return {
      ok: true,
      jobId,
      actions: [{ type: 'tencent_agent_run', ok: true, runId: result.runId }],
      analysis: `Tencent AI agent processed via CodeBuddy ${useCli ? 'CLI' : 'serve'}. Run ${result.runId}.${toolCallSummary}`,
      latency: totalLatency,
      model: 'tencent-codebuddy',
    };

  } catch (err) {
    const totalLatency = Date.now() - startTime;
    const ts = Date.now();
    const d = getDB();

    const job = d.prepare('SELECT attempts FROM ai_jobs WHERE id = ?').get(jobId);
    const attempts = (job?.attempts || 0) + 1;
    const willRetry = attempts < MAX_ATTEMPTS;

    updateJob(jobId, {
      status: willRetry ? 'pending' : 'failed',
      attempts,
      last_error: err.message.slice(0, 1000),
      latency_ms: totalLatency,
    });

    // Log the error
    d.prepare(
      `INSERT INTO ai_analysis_log (id, workspace_id, run_at, messages_total, messages_new, proposals_created, completion_claims, errors, last_message_seq, status, summary, created_at)
       VALUES (?, ?, ?, 0, 1, 0, 0, ?, 0, 'error', ?, ?)`,
    ).run(
      `al_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      workspaceId, ts, err.message.slice(0, 500),
      `Tencent AI error: ${err.message.slice(0, 200)}`,
      ts,
    );

    bumpRevision();

    return {
      ok: false,
      jobId,
      error: err.message,
      latency: totalLatency,
      willRetry,
    };

  } finally {
    inFlight.delete(messageId);
  }
}

// ─── Process pending jobs (recovery) ──────────────────────────────
export async function processPendingJobs() {
  const d = getDB();
  const pendingJobs = d.prepare(
    `SELECT * FROM ai_jobs WHERE status = 'pending' AND attempts < max_attempts ORDER BY created_at ASC LIMIT 10`,
  ).all();

  if (pendingJobs.length === 0) {
    return { processed: 0, message: 'No pending jobs to process' };
  }

  console.log(`[tencent-ai] Processing ${pendingJobs.length} pending jobs...`);

  let processed = 0;
  let failed = 0;
  const results = [];

  for (const job of pendingJobs) {
    // Get the message from the database
    const msg = d.prepare('SELECT * FROM messages WHERE id = ?').get(job.message_id);
    if (!msg) {
      updateJob(job.id, { status: 'failed', last_error: 'Message not found in database' });
      failed++;
      results.push({ jobId: job.id, status: 'failed', error: 'Message not found' });
      continue;
    }

    // Remove from inFlight if somehow stuck
    inFlight.delete(job.message_id);

    const result = await processMessage(job.workspace_id, job.message_id, msg.user, msg.body);
    results.push({
      jobId: job.id,
      messageId: job.message_id,
      ok: result.ok,
      skipped: result.skipped,
      latency: result.latency,
    });

    if (result.ok) {
      processed++;
    } else {
      failed++;
    }
  }

  return {
    processed,
    failed,
    total: pendingJobs.length,
    results,
  };
}

// ─── Get Tencent AI status ───────────────────────────────────────
export function getTencentStatus(workspaceId) {
  const d = getDB();

  const stats = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      AVG(CASE WHEN latency_ms > 0 THEN latency_ms ELSE NULL END) as avg_latency
    FROM ai_jobs WHERE workspace_id = ?
  `).get(workspaceId) || {};

  const recentJobs = d.prepare(
    `SELECT id, message_id, status, attempts, latency_ms, model_used, last_error, created_at, completed_at
     FROM ai_jobs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 10`,
  ).all(workspaceId) || [];

  return {
    provider: 'tencent-local',
    executionMode: EXECUTION_MODE,
    serveUrl: CODEBUDDY_SERVE_URL,
    serveAvailable: serveAvailable,
    cliPath: EXECUTION_MODE === 'cli' ? CODEBUDDY_CLI_PATH : undefined,
    enabled: TENCENT_ENABLED,
    stats: {
      total: stats.total || 0,
      completed: stats.completed || 0,
      pending: stats.pending || 0,
      processing: stats.processing || 0,
      failed: stats.failed || 0,
      avgLatencyMs: Math.round(stats.avg_latency || 0),
    },
    recentJobs,
  };
}
