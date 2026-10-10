#!/usr/bin/env node

/**
 * server/mcp-server.js — ShiftBridge MCP Server (Silent AI agent)
 *
 * Exposes 5 tools via stdio transport for WorkBuddy Desktop to call:
 *   1. list_tasks           — list all tasks in a workspace
 *   2. propose_task         — create a task proposal for manager review
 *   3. review_completion    — review a completion claim with AI reasoning
 *   4. refuse_protected_work— create a refusal proposal for protected work
 *   5. get_audit_trail      — get the audit log for a workspace
 *
 * The server communicates with the ShiftBridge REST API at
 * http://localhost:3000/api (configurable via SHIFTBRIDGE_API env var).
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdio (MCP standard)
 *
 * Usage in WorkBuddy Desktop MCP config:
 *   {
 *     "mcpServers": {
 *       "shiftbridge": {
 *         "command": "node",
 *         "args": ["C:\\path\\to\\server\\mcp-server.js"]
 *       }
 *     }
 *   }
 */

import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_BASE = process.env.SHIFTBRIDGE_API || 'http://localhost:3000/api';

// ── HTTP helper ──────────────────────────────────────────────────
async function apiRequest(method, path, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text }; }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ── Protected task logic (mirrors server/index.js) ────────────────
const PROTECTED_CATEGORIES = ['repairs', 'purchases', 'safety'];

function isProtectedTask(task) {
  return task.verification === 'qualified' || PROTECTED_CATEGORIES.includes(task.category);
}

// ── Tool definitions ─────────────────────────────────────────────
const TOOLS = [
  {
    name: 'list_tasks',
    description: 'List all tasks in a ShiftBridge workspace. Returns task IDs, names, statuses, assignees, categories, and verification requirements. Use this to see the current state of work in a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Workspace ID. Use "daily" for Daily Brew Café or "riverside" for Riverside Bakery.',
        },
      },
      required: ['workspace'],
    },
  },
  {
    name: 'propose_task',
    description: 'Propose a new task for the manager to review and approve. The proposal includes a summary, reasoning, and evidence. When the manager approves, the task is automatically created. This is how the Silent AI suggests work that needs to be done.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID' },
        name: { type: 'string', description: 'Short, clear task name (e.g., "Restock oat milk")' },
        description: { type: 'string', description: 'Detailed task description' },
        assignee: {
          type: 'string',
          description: 'Person ID to assign the task to: "jack", "emma", "sarah", "liam"',
        },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: 'Priority level' },
        category: {
          type: 'string',
          description: 'Task category: "routine", "inventory", "cleaning", "opening", "repairs", "purchases", "safety"',
        },
        due: { type: 'string', description: 'Due date (e.g., "Today", "Tomorrow", "2026-01-15")' },
        reasoning: {
          type: 'string',
          description: 'AI reasoning for why this task should be proposed',
        },
        evidence: {
          type: 'array',
          items: { type: 'string' },
          description: 'Evidence items supporting the proposal (e.g., "Oat milk stock at 2 cartons, below minimum")',
        },
      },
      required: ['workspace', 'name', 'reasoning'],
    },
  },
  {
    name: 'review_completion',
    description: 'Review a task completion claim that is in "review" status. Examines the task details, checks if verification is qualified, gathers evidence, produces AI reasoning, and creates a completion_review proposal for the manager to approve or reject. When approved, the task is marked done. When rejected, the task goes back to "doing".',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID' },
        taskId: { type: 'string', description: 'ID of the task in review status to evaluate' },
      },
      required: ['workspace', 'taskId'],
    },
  },
  {
    name: 'refuse_protected_work',
    description: 'Create a refusal proposal when an employee attempts to complete protected work (repairs, purchases, safety) without qualified verification. The AI explains why the work cannot be completed without proper review. The task remains in its current status until proper verification is obtained.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID' },
        taskId: { type: 'string', description: 'ID of the protected task' },
        reason: {
          type: 'string',
          description: 'Reason for refusal (e.g., "Requires qualified technician inspection before completion")',
        },
      },
      required: ['workspace', 'taskId', 'reason'],
    },
  },
  {
    name: 'get_audit_trail',
    description: 'Retrieve the full audit log for a workspace. Shows all task status changes, completion claims, AI proposals, enforcement actions, and manager reviews. Use this to understand the history of decisions in a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID' },
      },
      required: ['workspace'],
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────

async function list_tasks(args) {
  const data = await apiRequest('GET', `/workspaces/${args.workspace}/tasks`);
  // Enhance with a summary line for the AI.
  const tasks = data.tasks || [];
  const summary = `${tasks.length} tasks in workspace "${args.workspace}":\n` +
    tasks.map((t) => {
      const flag = isProtectedTask(t) ? ' [PROTECTED]' : '';
      return `  • ${t.id}: "${t.name}" — status: ${t.status}, assignee: ${t.assignee || 'unassigned'}, category: ${t.category}, verification: ${t.verification}${flag}`;
    }).join('\n');
  return { summary, tasks };
}

async function propose_task(args) {
  const {
    workspace, name, description = '', assignee, priority = 'normal',
    category = 'routine', due = 'Today', reasoning, evidence = [],
  } = args;

  const proposal = await apiRequest('POST', `/workspaces/${workspace}/proposals`, {
    type: 'task_proposal',
    summary: `Propose new task: "${name}"`,
    reasoning,
    evidence: evidence.length ? evidence : [`AI analysis of workspace state suggests this task is needed`],
    confidence: 'high',
    proposedData: { name, description, assignee, priority, category, due },
  });

  return {
    message: `Task proposal created successfully. Manager will review it in the dashboard.`,
    proposal,
  };
}

async function review_completion(args) {
  const { workspace, taskId } = args;

  // Get the task details.
  const task = await apiRequest('GET', `/tasks/${taskId}`);

  if (task.status !== 'review') {
    return {
      error: `Task "${task.name}" (ID: ${taskId}) is not in review status (current: ${task.status}). Only tasks in "review" status can be reviewed.`,
      task,
    };
  }

  // Gather evidence and produce AI reasoning.
  const evidence = [];
  evidence.push(`Task name: ${task.name}`);
  evidence.push(`Category: ${task.category}`);
  evidence.push(`Verification type: ${task.verification}`);
  evidence.push(`Completion claim: "${task.completion || '(none)'}"`);
  evidence.push(`Assigned to: ${task.assignee || 'unassigned'}`);
  evidence.push(`Created by: ${task.createdBy || 'unknown'}`);

  const protectedCategory = PROTECTED_CATEGORIES.includes(task.category);
  const isQualified = task.verification === 'qualified';

  let reasoning;
  let confidence;

  if (isQualified || protectedCategory) {
    reasoning =
      `This task requires qualified verification because it is in the "${task.category}" category ` +
      `with verification="${task.verification}". The employee (${task.assignee}) has submitted a ` +
      `completion claim: "${task.completion}". As the Silent AI, I have examined the task details ` +
      `and recommend that the manager review this claim carefully. If the evidence indicates that ` +
      `proper qualified inspection was completed, approve the completion. Otherwise, reject it ` +
      `and the task will return to "doing" status for rework.`;
    confidence = 'medium';
    evidence.push(`Protected category: ${protectedCategory ? 'YES — requires qualified review' : 'No, but verification is qualified'}`);
  } else {
    reasoning =
      `This is a routine task with self-report verification. The employee (${task.assignee}) has ` +
      `submitted the completion claim: "${task.completion}". Based on the task details, this appears ` +
      `to be a straightforward self-reported completion with no qualified verification required. ` +
      `I recommend approval unless there are specific concerns about the quality of work.`;
    confidence = 'high';
    evidence.push(`Protected category: No — routine self-report task`);
  }

  // Create the completion_review proposal.
  const proposal = await apiRequest('POST', `/workspaces/${workspace}/proposals`, {
    type: 'completion_review',
    entityType: 'task',
    entityId: taskId,
    summary: `Review completion of "${task.name}" by ${task.assignee || 'employee'}`,
    evidence,
    reasoning,
    confidence,
  });

  return {
    message: `Completion review proposal created. Manager will see the evidence and reasoning in the dashboard.`,
    proposal,
    aiReasoning: reasoning,
    evidence,
  };
}

async function refuse_protected_work(args) {
  const { workspace, taskId, reason } = args;

  const task = await apiRequest('GET', `/tasks/${taskId}`);

  const evidence = [
    `Task name: ${task.name}`,
    `Category: ${task.category}`,
    `Verification required: ${task.verification}`,
    `Current status: ${task.status}`,
    `Reason for refusal: ${reason}`,
  ];

  const reasoning =
    `Protected work cannot be completed without qualified verification. ` +
    `Task "${task.name}" is in category "${task.category}" which requires qualified human review. ` +
    `The employee's attempt to mark this task as done has been intercepted by the server-side ` +
    `enforcement layer and redirected to "review" status. ` +
    `Reason: ${reason}`;

  const proposal = await apiRequest('POST', `/workspaces/${workspace}/proposals`, {
    type: 'refusal',
    entityType: 'task',
    entityId: taskId,
    summary: `Refused: "${task.name}" requires qualified verification`,
    evidence,
    reasoning,
    confidence: 'high',
  });

  return {
    message: `Refusal proposal created. The task remains in review status until proper verification is obtained.`,
    proposal,
    aiReasoning: reasoning,
  };
}

async function get_audit_trail(args) {
  const data = await apiRequest('GET', `/workspaces/${args.workspace}/audit`);
  const audit = data.audit || [];
  const summary = `${audit.length} audit entries in workspace "${args.workspace}":\n` +
    audit.map((a) => {
      return `  • [${a.action}] ${a.entityType || ''}/${a.entityId || ''} by ${a.actor}: ${a.details}`;
    }).join('\n');
  return { summary, audit };
}

const TOOL_HANDLERS = {
  list_tasks,
  propose_task,
  review_completion,
  refuse_protected_work,
  get_audit_trail,
};

// ── MCP Protocol (JSON-RPC 2.0 over newline-delimited stdio) ─────

const rl = createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg) {
  const { method, params, id } = msg;

  // Notifications (no id) don't require a response.
  if (id === undefined || id === null) {
    // Handle notifications/initialized silently.
    return;
  }

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'shiftbridge-silent-ai',
            version: '1.0.0',
          },
        },
      });
    } else if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      });
    } else if (method === 'resources/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: { resources: [] },
      });
    } else if (method === 'prompts/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: { prompts: [] },
      });
    } else if (method === 'tools/call') {
      const { name, arguments: args } = params || {};
      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Unknown tool: ${name}` },
        });
        return;
      }
      try {
        const result = await handler(args || {});
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Tool execution error: ${err.message}` }],
            isError: true,
          },
        });
      }
    } else {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      });
    }
  } catch (err) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err.message },
    });
  }
}

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    handleMessage(msg);
  } catch (err) {
    process.stderr.write(`Parse error: ${err.message}\n`);
  }
});

rl.on('close', () => {
  process.stderr.write('ShiftBridge MCP Server: stdin closed, shutting down.\n');
  process.exit(0);
});

process.stderr.write('ShiftBridge MCP Server started (stdio transport)\n');
process.stderr.write(`API base: ${API_BASE}\n`);
process.stderr.write(`Tools: ${TOOLS.map((t) => t.name).join(', ')}\n`);
