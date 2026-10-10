#!/usr/bin/env node

/**
 * server/mcp-server.js — ShiftBridge MCP Server (Silent AI agent)
 *
 * Exposes 12 tools via stdio transport for WorkBuddy Desktop to call:
 *   1. get_recent_messages     — read recent chat messages from a workspace
 *   2. get_active_tasks        — list tasks with status, assignee, protected flags
 *   3. get_workspace_rules     — show permitted/locked categories per workspace
 *   4. list_tasks              — list all tasks in a workspace (alias of get_active_tasks)
 *   5. propose_task            — create a task proposal for manager review
 *   6. propose_completion      — review a completion claim and create a proposal
 *   7. refuse_protected_work   — create a refusal proposal for protected work
 *   8. get_audit_trail         — get the audit log for a workspace
 *   9. propose_chat_completion — process a chat-derived completion claim
 *  10. create_manager_task     — create a task directly from a manager chat message
 *  11. get_reported_issues      — get issues flagged by employees in a workspace
 *  12. propose_announcement_draft — draft an announcement based on workspace data
 *
 * CRITICAL SAFETY: Protected tasks (repairs, purchases, safety) remain in
 * 'review' status when a manager approves the AI completion_review, UNLESS
 * the manager provides explicit qualified verification evidence. A demo
 * manager role alone is NOT qualified verification.
 *
 * CHAT COMPLETION (Phase 4): The AI can detect completion claims in employee
 * chat messages and submit them through propose_chat_completion. The server
 * validates the message, task, and employee identity, prevents duplicate
 * processing, applies the workspace verification policy, and records the claim
 * with linked evidence. The AI NEVER posts to the shared chat.
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
    description: 'Get recent chat messages from a ShiftBridge workspace. Returns message IDs, sender, body, timestamp, and sequence number. Supports cursor-based pagination via sinceSeq — only messages with seq > sinceSeq are returned. Use hasMore and nextSinceSeq to paginate through large message histories without reprocessing already-seen messages.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID (e.g., "daily" for Daily Brew Café)' },
        count: { type: 'number', description: 'Number of recent messages to retrieve (default: 20). Deprecated — use limit instead.' },
        sinceSeq: { type: 'number', description: 'Only return messages with seq > sinceSeq. Use this for checkpoint-based pagination to avoid reprocessing messages from previous runs.' },
        limit: { type: 'number', description: 'Maximum number of messages to return per batch (default: 50, max: 200). Use hasMore + nextSinceSeq to fetch the next batch.' },
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
        sourceMessageId: {
          type: 'string',
          description: 'ID of the chat message that prompted this task proposal. Used for deduplication — prevents duplicate proposals from repeated analysis runs on the same message.',
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
  {
    name: 'propose_chat_completion',
    description: 'Process a chat-derived completion claim. The AI detects that an employee has reported task completion in a chat message and submits the claim for processing. The server validates the message, task, and employee identity, prevents duplicate processing, and applies the workspace verification policy. Routine tasks are marked done (self-attestation, not independent proof). Protected tasks (repairs, purchases, safety) are moved to review status and require qualified human verification. The AI never posts to the shared chat. Requires a real source message ID, task ID, and reporting employee.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID' },
        taskId: { type: 'string', description: 'ID of the task being reported as complete' },
        messageId: { type: 'string', description: 'ID of the chat message containing the completion claim' },
        reportingEmployee: { type: 'string', description: 'Person ID of the employee reporting completion (must match the task assignee)' },
        claimType: {
          type: 'string',
          enum: ['completion', 'progress', 'ambiguous'],
          description: 'Type of claim detected: "completion" (clear completion), "progress" (progress-only, not a completion), "ambiguous" (unclear if completion)',
          default: 'completion',
        },
      },
      required: ['workspace', 'taskId', 'messageId', 'reportingEmployee'],
    },
  },
  {
    name: 'create_manager_task',
    description: 'Create a task directly from a manager\'s chat message without requiring a proposal and approval cycle. The server validates that the message was sent by the workspace manager and that the task category is not protected (repairs, purchases, safety). If the message was not sent by the manager, the task is not created. If the category is protected, the AI should instead use propose_task. The task is immediately visible to the assignee — no review cycle. This tool implements Workflow A: automatic manager task assignment.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID' },
        messageId: { type: 'string', description: 'ID of the chat message from the manager containing the task instruction' },
        taskName: { type: 'string', description: 'Short, clear task name extracted from the manager message (e.g., "Check paper napkins quantity")' },
        assignee: {
          type: 'string',
          description: 'Person ID to assign the task to. Must be a workspace member. Options: "jack", "emma", "sarah", "liam"',
        },
        due: { type: 'string', description: 'Due date or time (e.g., "Today", "Tomorrow", "Before closing")', default: 'Today' },
        category: {
          type: 'string',
          description: 'Task category. Must NOT be a protected category (repairs, purchases, safety). Use: "routine", "inventory", "cleaning", "opening"',
          default: 'routine',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high'],
          description: 'Priority level',
          default: 'normal',
        },
        description: { type: 'string', description: 'Detailed task description extracted from the manager message' },
      },
      required: ['workspace', 'messageId', 'taskName', 'assignee'],
    },
  },
  {
    name: 'get_reported_issues',
    description: 'Get all issues that have been flagged by employees from chat messages in a workspace. Returns issue details including the reporter, linked announcement, issue type, and resolution status. Use this to review the current state of employee-reported problems and to identify issues that may warrant an announcement. This tool supports Workflow B (employee flagging) and Workflow C (announcement creation based on issues).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID' },
        status: {
          type: 'string',
          enum: ['open', 'resolved', 'all'],
          description: 'Filter by resolution status. "open" for unresolved issues, "resolved" for resolved, "all" for everything.',
          default: 'open',
        },
      },
      required: ['workspace'],
    },
  },
  {
    name: 'propose_announcement_draft',
    description: 'Draft an announcement based on workspace data, particularly open issues. The AI analyzes reported issues, their severity, and their type to produce a suggested announcement title, body, and type. This tool does NOT publish the announcement — it returns a draft that the manager must review and publish through the frontend. The AI never publishes announcements directly. If a linked issue is specified, the draft will reference that issue. This tool supports Workflow C: manager-controlled announcements.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace ID' },
        linkedIssueId: {
          type: 'string',
          description: 'Optional issue ID to link the announcement to. If provided, the draft will reference the issue and suggest a safety announcement if the issue is safety-related.',
        },
        announcementType: {
          type: 'string',
          enum: ['general', 'safety', 'operational'],
          description: 'Type of announcement to draft. If not specified, the AI determines the type based on the issue data.',
        },
      },
      required: ['workspace'],
    },
  },
];

// ── Tool implementations ─────────────────────────────────────────

async function get_recent_messages(args) {
  const limit = Math.min(args.limit || args.count || 20, 200);
  const sinceSeq = args.sinceSeq || 0;

  // Build query string for the API call.
  const params = new URLSearchParams();
  if (sinceSeq) params.set('sinceSeq', sinceSeq);
  params.set('limit', String(limit));

  const data = await apiRequest('GET', `/workspaces/${args.workspace}/messages?${params}`);
  const messages = data.messages || [];
  const hasMore = data.hasMore || false;
  const nextSinceSeq = data.nextSinceSeq || null;

  const summary = `${messages.length} messages in workspace "${args.workspace}"` +
    (sinceSeq ? ` (since seq ${sinceSeq})` : '') +
    (hasMore ? ` — more available (nextSinceSeq: ${nextSinceSeq})` : '') +
    ':\n' +
    messages.map((m) => `[${m.id}] seq:${m.seq} ${m.user}: ${m.body}`).join('\n');
  return { summary, messages, hasMore, nextSinceSeq };
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
    sourceMessageId = null,
  } = args;

  const proposal = await apiRequest('POST', `/workspaces/${workspace}/proposals`, {
    type: 'task_proposal',
    summary: `Propose new task: "${name}"`,
    reasoning,
    evidence: evidence.length ? evidence : [`AI analysis of workspace state suggests this task is needed`],
    confidence: 'high',
    proposedData: { name, description, assignee, priority, category, due },
    sourceMessageId,
  });

  return {
    message: proposal.duplicate
      ? `Task proposal already exists for this source message. No duplicate created.`
      : `Task proposal created successfully. Manager will review it in the dashboard.`,
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

async function propose_chat_completion(args) {
  const { workspace, taskId, messageId, reportingEmployee, claimType = 'completion' } = args;

  // Validate required parameters.
  if (!workspace) return { error: 'workspace is required' };
  if (!taskId) return { error: 'taskId is required' };
  if (!messageId) return { error: 'messageId is required — a real source message ID is needed' };
  if (!reportingEmployee) return { error: 'reportingEmployee is required' };

  // Call the backend API to process the chat-derived completion claim.
  try {
    const result = await apiRequest('POST', `/workspaces/${workspace}/chat-completion`, {
      taskId,
      messageId,
      reportingEmployee,
      claimType,
    });

    // Build a summary for the AI.
    const protected_ = result.protectedTask ? ' [PROTECTED]' : '';
    const summary = result.protectedTask
      ? `Chat completion claim processed. Task "${result.task?.name}" moved to REVIEW — qualified verification required.${protected_}\n` +
        `  Claim ID: ${result.claim?.id}\n` +
        `  Verification applied: ${result.verificationApplied}\n` +
        `  Source message: ${messageId} (${result.sourceMessage?.user}: "${result.sourceMessage?.body}")\n` +
        `  CRITICAL: This is an employee self-attestation, NOT independent proof. Qualified human verification required.`
      : `Chat completion claim processed. Task "${result.task?.name}" marked DONE (self-attestation).${protected_}\n` +
        `  Claim ID: ${result.claim?.id}\n` +
        `  Verification applied: ${result.verificationApplied}\n` +
        `  Source message: ${messageId} (${result.sourceMessage?.user}: "${result.sourceMessage?.body}")\n` +
        `  NOTE: This is a self-reported claim, NOT independent proof of completion.`;

    return {
      message: result.message,
      summary,
      claim: result.claim,
      task: result.task,
      proposal: result.proposal,
      verificationApplied: result.verificationApplied,
      finalTaskStatus: result.finalTaskStatus,
      protectedTask: result.protectedTask,
      sourceMessage: result.sourceMessage,
    };
  } catch (err) {
    // The API returns structured error responses for known rejection cases.
    // Parse them to provide clear diagnostics.
    const errorParts = (err.message || '').split('|');
    return {
      error: err.message,
      taskId,
      messageId,
      reportingEmployee,
      workspace,
      diagnostic: 'The completion claim could not be processed. Common causes: wrong employee (reporting employee does not match task assignee), duplicate (message already processed for this task), message not found (messageId does not exist in this workspace), or task not found (taskId does not exist in this workspace).',
    };
  }
}

// ── Phase 6: Manager task creation, issue reporting, announcement drafts ─

async function create_manager_task(args) {
  const {
    workspace, messageId, taskName, assignee,
    due = 'Today', category = 'routine', priority = 'normal',
    description = '',
  } = args;

  // Validate required parameters.
  if (!workspace) return { error: 'workspace is required' };
  if (!messageId) return { error: 'messageId is required — a real source message ID from the manager is needed' };
  if (!taskName) return { error: 'taskName is required — extract a clear task name from the manager message' };
  if (!assignee) return { error: 'assignee is required — specify which employee the task is for' };

  // Check for protected categories — these must go through propose_task instead.
  if (PROTECTED_CATEGORIES.includes(category)) {
    return {
      error: `Category "${category}" is protected. Protected categories (repairs, purchases, safety) cannot be created via direct manager task assignment. Use the propose_task tool instead to create a proposal for manager review.`,
      protectedCategory: true,
      suggestion: 'Use propose_task instead for protected categories.',
    };
  }

  try {
    const result = await apiRequest('POST', `/workspaces/${workspace}/manager-task`, {
      sourceMessageId: messageId,
      name: taskName,
      assignee,
      due,
      category,
      priority,
      description,
      createdBy: 'ai-agent',
    });

    const summary = result.duplicate
      ? `Task already exists for this message. No duplicate created.\n  Task: "${result.task?.name}" — assigned to ${result.task?.assignee}\n  Source message: ${messageId}`
      : `Manager task created successfully — no approval needed.\n  Task: "${result.task?.name}" (ID: ${result.task?.id})\n  Assigned to: ${result.task?.assignee}\n  Category: ${result.task?.category}\n  Due: ${result.task?.due}\n  Source message: ${messageId}\n  The task is immediately visible to the assignee.`;

    return {
      message: result.duplicate
        ? 'Task already exists for this source message. No duplicate created.'
        : 'Manager task created successfully. The task is immediately visible to the assignee — no review cycle.',
      summary,
      task: result.task,
      duplicate: result.duplicate || false,
      sourceMessage: result.sourceMessage,
    };
  } catch (err) {
    return {
      error: err.message,
      workspace,
      messageId,
      taskName,
      assignee,
      diagnostic: 'The manager task could not be created. Common causes: message not found (messageId does not exist), author is not the workspace manager, assignee is not a workspace member, or the message was already processed (duplicate).',
    };
  }
}

async function get_reported_issues(args) {
  const { workspace, status = 'open' } = args;

  if (!workspace) return { error: 'workspace is required' };

  try {
    const data = await apiRequest('GET', `/workspaces/${workspace}/issues`);
    let issues = data.issues || [];

    // Filter by status if not 'all'.
    if (status !== 'all') {
      issues = issues.filter((i) => i.status === status);
    }

    // Separate employee-reported issues (have a reporterId) from AI-detected issues.
    const reported = issues.filter((i) => i.reporterId);
    const aiDetected = issues.filter((i) => !i.reporterId);

    const summary = `${reported.length} employee-reported issues (status: ${status}) in workspace "${workspace}":\n` +
      reported.map((i) => {
        const linked = i.linkedAnnouncementId ? ` [Linked announcement: ${i.linkedAnnouncementId}]` : '';
        const verified = i.qualifiedVerifier ? ` [Verified by ${i.qualifiedVerifier}]` : '';
        return `  • ${i.id}: "${i.title}" — ${i.status}, type: ${i.issueType || 'unspecified'}, reporter: ${i.reporterId}${linked}${verified}\n    Description: ${i.description || '(none)'}`;
      }).join('\n') +
      (aiDetected.length ? `\n\n${aiDetected.length} AI-detected issues (no employee reporter):\n` +
        aiDetected.map((i) => `  • ${i.id}: "${i.title}" — ${i.status}`).join('\n') : '');

    return {
      summary,
      reportedIssues: reported,
      aiDetectedIssues: aiDetected,
      total: issues.length,
    };
  } catch (err) {
    return {
      error: err.message,
      workspace,
      diagnostic: 'Could not retrieve issues. The workspace may not exist or the issues endpoint is unavailable.',
    };
  }
}

async function propose_announcement_draft(args) {
  const { workspace, linkedIssueId, announcementType } = args;

  if (!workspace) return { error: 'workspace is required' };

  try {
    // Get issues for the workspace to analyze.
    const issuesData = await apiRequest('GET', `/workspaces/${workspace}/issues`);
    let issues = (issuesData.issues || []).filter((i) => i.status === 'open');

    // If linkedIssueId is specified, focus on that issue.
    let linkedIssue = null;
    if (linkedIssueId) {
      linkedIssue = (issuesData.issues || []).find((i) => i.id === linkedIssueId);
      if (!linkedIssue) {
        return {
          error: `Issue "${linkedIssueId}" not found in workspace "${workspace}"`,
          diagnostic: 'The linkedIssueId does not match any issue in this workspace.',
        };
      }
      issues = linkedIssue ? [linkedIssue] : issues;
    }

    if (issues.length === 0) {
      return {
        message: 'No open issues found. An announcement is most useful when linked to an active issue.',
        draft: null,
        suggestion: 'Wait for issues to be reported before drafting an announcement, or draft a general announcement manually from the management dashboard.',
      };
    }

    // Determine announcement type if not specified.
    const hasSafetyIssue = issues.some((i) =>
      i.issueType === 'safety' || i.title?.toLowerCase().includes('safety') ||
      i.description?.toLowerCase().includes('safety') ||
      i.title?.toLowerCase().includes('danger') ||
      i.description?.toLowerCase().includes('danger')
    );
    const type = announcementType || (hasSafetyIssue ? 'safety' : 'general');

    // Generate draft title and body based on issues.
    const primaryIssue = linkedIssue || issues[0];
    const allIssueTitles = issues.map((i) => i.title).join(', ');

    let draftTitle;
    let draftBody;

    if (linkedIssue) {
      draftTitle = type === 'safety'
        ? `Safety notice: ${linkedIssue.title}`
        : `Team update: ${linkedIssue.title}`;
      draftBody =
        `This is an official notice regarding the following issue:\n\n` +
        `${linkedIssue.description || linkedIssue.title}\n\n` +
        `Status: ${linkedIssue.status.toUpperCase()}\n` +
        (linkedIssue.reporterId ? `Reported by: ${linkedIssue.reporterId}\n` : '') +
        (linkedIssue.issueType ? `Type: ${linkedIssue.issueType}\n` : '') +
        `\nPlease review and follow any instructions from management. ` +
        `If you have questions, contact the shift lead.`;
    } else if (issues.length === 1) {
      draftTitle = type === 'safety'
        ? `Safety notice: ${issues[0].title}`
        : `Team update: ${issues[0].title}`;
      draftBody =
        `${issues[0].description || issues[0].title}\n\n` +
        `Status: ${issues[0].status.toUpperCase()}\n` +
        (issues[0].reporterId ? `Reported by: ${issues[0].reporterId}\n` : '') +
        `\nPlease review and follow any instructions from management.`;
    } else {
      draftTitle = type === 'safety'
        ? 'Safety notice: Multiple issues require attention'
        : 'Team update: Important issues to review';
      draftBody =
        `The following issues are currently open in this workspace:\n\n` +
        issues.map((i, idx) => `${idx + 1}. ${i.title}${i.issueType ? ` (${i.issueType})` : ''}`).join('\n') +
        `\n\nPlease review each issue and follow instructions from management. ` +
        `Contact the shift lead if you have questions.`;
    }

    const summary =
      `Announcement draft prepared (NOT published — manager must review and publish from the dashboard).\n` +
      `Type: ${type}\n` +
      `Title: ${draftTitle}\n` +
      `Body preview: ${draftBody.slice(0, 200)}...\n` +
      (linkedIssue ? `Linked issue: ${linkedIssue.id} — "${linkedIssue.title}"\n` : '') +
      `Based on ${issues.length} open issue(s): ${allIssueTitles}\n` +
      `\nCRITICAL: The AI does NOT publish announcements. The manager must review this draft, edit if needed, and publish from the management dashboard.`;

    return {
      message: 'Announcement draft prepared. The manager must review and publish it from the management dashboard. The AI does not publish announcements.',
      summary,
      draft: {
        title: draftTitle,
        body: draftBody,
        type,
        linkedIssueId: linkedIssue?.id || null,
        aiGenerated: true,
      },
      issuesAnalyzed: issues.length,
    };
  } catch (err) {
    return {
      error: err.message,
      workspace,
      diagnostic: 'Could not retrieve workspace data for announcement drafting.',
    };
  }
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
  propose_chat_completion,
  create_manager_task,
  get_reported_issues,
  propose_announcement_draft,
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
process.stderr.write(`Tools (${TOOLS.length}): ${TOOLS.map((t) => t.name).join(', ')}\n`);
