#!/usr/bin/env node

/**
 * server/mcp-server.js — ShiftBridge MCP Server (Silent AI agent)
 *
 * Exposes 8 tools via stdio transport for WorkBuddy Desktop to call:
 *   1. get_recent_messages  — read recent chat messages from a workspace
 *   2. get_active_tasks     — list tasks with status, assignee, protected flags
 *   3. get_workspace_rules   — show permitted/locked categories per workspace
 *   4. list_tasks           — list all tasks in a workspace (alias of get_active_tasks)
 *   5. propose_task          — create a task proposal for manager review
 *   6. propose_completion    — review a completion claim and create a proposal
 *   7. refuse_protected_work — create a refusal proposal for protected work
 *   8. get_audit_trail       — get the audit log for a workspace
 *
 * CRITICAL SAFETY: Protected tasks (repairs, purchases, safety) remain in
 * 'review' status when a manager approves the AI completion_review, UNLESS
 * the manager provides explicit qualified verification evidence. A demo
 * manager role alone is NOT qualified verification.
 *
 * The server communicates with the ShiftBridge REST API at
 * http://localhost:3000/api (configurable via SHIFTBRIDGE_API env var).
 *
 * Protocol: JSON-RPC 2.0 over newline-delimited stdio (MCP standard)
 * Protocol version: 2024-11-05
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

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

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
    name: 'get_recent_messages',
    description: 'Get recent chat messages from a ShiftBridge workspace. Returns message IDs, sender, body, and timestamp. Use this to understand what the team is discussing and find action items.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID (e.g., "daily" for Daily Brew Café)' },
        count: { type: 'number', description: 'Number of recent messages to retrieve (default: 20, max: 50)' },
      },
      required: ['workspace'],
    },
  },
  {
    name: 'get_active_tasks',
    description: 'Get all tasks in a ShiftBridge workspace, including their status, assignee, category, verification type, and whether they are protected. Returns tasks sorted by creation time.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID (e.g., "daily")' },
        status: { type: 'string', description: 'Filter by status: "todo", "doing", "review", "done". Omit for all.' },
      },
      required: ['workspace'],
    },
  },
  {
    name: 'get_workspace_rules',
    description: 'Get the permission rules for a workspace. Shows which task categories are allowed (self-report) and which are locked (require qualified verification). Locked categories: repairs, purchases, safety.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID (e.g., "daily")' },
      },
      required: ['workspace'],
    },
  },
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
    name: 'propose_completion',
    description: 'Review a task completion claim that is in "review" status. Examines the task details, checks if verification is qualified, gathers evidence, produces AI reasoning, and creates a completion_review proposal for the manager to approve or reject. When approved WITH qualified verification evidence, the task is marked done. When approved WITHOUT qualified evidence for protected tasks (repairs, purchases, safety), the task remains in review. When rejected, the task goes back to "doing".',
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

async function get_recent_messages(args) {
  const count = Math.min(args.count || 20, 50);
  const data = await apiRequest('GET', `/workspaces/${args.workspace}/messages`);
  const messages = (data.messages || []).slice(-count);
  const summary = `${messages.length} recent messages in workspace "${args.workspace}":\n` +
    messages.map((m) => `[${m.id}] ${m.user}: ${m.body}`).join('\n');
  return { summary, messages };
}

async function get_active_tasks(args) {
  const q = args.status ? `?status=${args.status}` : '';
  // The tasks endpoint doesn't filter by status, so we filter client-side.
  const data = await apiRequest('GET', `/workspaces/${args.workspace}/tasks`);
  let tasks = data.tasks || [];
  if (args.status) tasks = tasks.filter((t) => t.status === args.status);
  const summary = `${tasks.length} tasks in workspace "${args.workspace}":\n` +
    tasks.map((t) => {
      const flag = isProtectedTask(t) ? ' [PROTECTED]' : '';
      return `  • ${t.id}: "${t.name}" — status: ${t.status}, assignee: ${t.assignee || 'unassigned'}, category: ${t.category}, verification: ${t.verification}${flag}`;
    }).join('\n');
  return { summary, tasks };
}

async function get_workspace_rules(args) {
  const data = await apiRequest('GET', `/workspaces`);
  const ws = (data.workspaces || []).find((w) => w.id === args.workspace);
  if (!ws) return { error: `Workspace "${args.workspace}" not found` };
  const rules = ws.rules || [];
  const summary = `${rules.length} rules for workspace "${ws.name}":\n` +
    rules.map((r) => {
      const lock = r.locked ? ' [LOCKED — requires qualified verification]' : '';
      const allow = r.allowed ? 'allowed (self-report)' : 'requires review';
      return `  • ${r.id}: ${r.name} — ${allow}${lock}`;
    }).join('\n');
  return { summary, rules, workspace: { id: ws.id, name: ws.name } };
}

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

async function propose_completion(args) {
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
      `and recommend that the manager review this claim carefully. CRITICAL: If the manager approves ` +
      `this completion, they MUST provide explicit qualified verification evidence (e.g., technician ` +
      `inspection report, safety certificate, purchase receipt verification). Without qualified ` +
      `verification evidence, the task will REMAIN in "review" status even if approved — a demo ` +
      `manager role alone is NOT sufficient. If the evidence is insufficient, reject and the task ` +
      `returns to "doing" status for rework.`;
    confidence = 'medium';
    evidence.push(`Protected category: ${protectedCategory ? 'YES — requires qualified review' : 'No, but verification is qualified'}`);
    evidence.push(`SAFETY NOTE: Manager approval requires qualifiedVerification evidence to mark task done`);
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
  get_recent_messages,
  get_active_tasks,
  get_workspace_rules,
  list_tasks,
  propose_task,
  propose_completion,
  refuse_protected_work,
  get_audit_trail,
};

// ── MCP Protocol (official @modelcontextprotocol/sdk) ────────────

const server = new Server(
  { name: 'shiftbridge-silent-ai', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// Register tools/list handler — returns our tool definitions.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Register tools/call handler — dispatches to the appropriate tool handler.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await handler(args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Tool execution error: ${err.message}` }],
      isError: true,
    };
  }
});

// Connect via stdio transport — the SDK handles all JSON-RPC protocol
// negotiation, method dispatching, and error handling.
const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write('ShiftBridge MCP Server started (official SDK, stdio transport)\n');
process.stderr.write(`API base: ${API_BASE}\n`);
process.stderr.write(`Tools: ${TOOLS.map((t) => t.name).join(', ')}\n`);
