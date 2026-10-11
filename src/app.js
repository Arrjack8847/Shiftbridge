/**
 * src/app.js — ShiftBridge frontend application.
 *
 * ARCHITECTURE:
 *   The Node.js backend (server/) is the single source of truth for all
 *   shared data — messages, tasks, issues, workspaces, rules.
 *   This file loads data from the REST API, renders the same UI as the
 *   original localStorage prototype, and synchronises via:
 *     • SSE (Server-Sent Events) for push notifications
 *     • 2-second polling as a fallback
 *
 * IDENTITY:
 *   No authentication. A demo identity selector lets each phone pick a
 *   person (Manager / Jack / Emma / Sarah / Liam). The selection persists
 *   in that phone's localStorage only. Shared data lives on the server.
 *
 * All rendering functions are preserved from the original prototype.
 */

import { icon } from './icons.js';
import { api } from './api.js';
import {
  demoPeople, escapeHTML as e, safeID, displayTime, formatDate,
  getIdentity, setIdentity, clearIdentity, roleForUser,
} from './data.js';

// ── Global state ──────────────────────────────────────────────────
// `data` is the in-memory mirror of what the server holds.
// It is refreshed from the API on load and every 2 seconds (poll) / on SSE push.
let data = {
  workspaces: [],
  messages: [],
  tasks: [],
  issues: [],
  agentFeedback: [],
  proposals: [],
  completionClaims: [],
  announcements: [],
  aiStatus: null,
  shifts: {},
  handovers: {},
};
let currentWorkspace = 'daily';
let identity = null;     // { userId, role } from localStorage
let serverRevision = 0;
let loading = true;
let connectionStatus = 'connecting'; // 'connecting' | 'online' | 'offline'

let currentTaskFilter = 'todo';
let allWorkFilter = 'all';
let toast = '';
let openWorkspaces = false;
let activeDialog = '';
let pendingIssueId = null;
let flagMsgId = null;       // message being flagged as issue
let pendingAnnouncementDraft = null; // AI-suggested draft for compose dialog
let pendingAnnouncementId = null; // announcement being edited
let lastRoute = '';

const app = document.querySelector('#app');
const $ = (s) => document.querySelector(s);
const workspace = () => data.workspaces.find((w) => w.id === currentWorkspace) || data.workspaces[0] || { id: '', name: '', type: '', members: [], rules: [], invite: '' };
const member = (id) => demoPeople.find((p) => p.id === id) || { name: id || 'Unassigned', initials: '?', hue: 'blue', role: 'Employee' };
const wsItems = (arr) => arr.filter((x) => x.ws === currentWorkspace);
const route = () => decodeURIComponent(location.hash.replace(/^#\/?/, '').split('?')[0] || 'chat');
const admin = () => identity?.role === 'admin';

// ── Navigation & rendering helpers (unchanged from original) ──────
function nav(path) { location.hash = '/' + path; if (route() === path) render(); }
function badge(label, tone = '') { return `<span class="badge ${tone}">${e(label)}</span>`; }
function personAvatar(id, big = false) { const p = member(id); return `<span class="avatar ${p.hue} ${big ? 'big' : ''}" aria-label="${e(p.name)}">${e(p.initials)}</span>`; }
function alertCount() { return wsItems(data.issues).filter((i) => i.status !== 'resolved').length + wsItems(data.tasks).filter((t) => ['review', 'blocked'].includes(t.status)).length; }
function myTaskCount() { return wsItems(data.tasks).filter((t) => t.assignee === identity?.userId && ['todo', 'doing'].includes(t.status)).length; }
function navLink(path, title, ic, active) { const count = title === 'Tasks' ? myTaskCount() : title === 'Manage' ? alertCount() : 0; return `<button class="side-link ${active ? 'active' : ''}" data-nav="${path}">${icon(ic)}<span>${title}</span>${count ? `<span class="count">${count}</span>` : ''}</button>`; }
function sideBar(path) { return `<aside class="side" aria-label="Desktop navigation"><div class="brand"><img src="./assets/mark.svg" alt=""/>Shift<b>Bridge</b></div><button class="workspace-side" data-action="workspace-menu">${icon('coffee')}<span class="grow"><strong>${e(workspace()?.name || '')}</strong><small>${e(workspace()?.type || '')}</small></span>${icon('down', 15)}</button>${navLink('chat', 'Chat', 'chat', path === 'chat')}${navLink('tasks', 'Tasks', 'tasks', path === 'tasks' || path.startsWith('task/'))}${navLink('shift', 'Shift', 'clock', path === 'shift' || path === 'handover')}${admin() ? navLink('manage', 'Manage', 'manage', path.startsWith('manage') || path.startsWith('workspace')) : ''}<div class="side-spacer"></div><button class="side-link side-profile" data-nav="profile">${personAvatar(identity?.userId)}<span><strong>${e(member(identity?.userId).name)}</strong><br/><small>${admin() ? 'Administrator' : 'Employee'}</small></span></button></aside>`; }
function mobileHeader(path) { const back = ['task/', 'manage/', 'workspace/'].some((x) => path.startsWith(x)) || path === 'profile' || path === 'handover'; return `<header class="mobile-header">${back ? `<button class="icon-btn" data-action="back" aria-label="Back">${icon('back')}</button>` : ''}<button class="workspace-open grow" data-action="workspace-menu" aria-label="Switch workspace"><strong>${e(workspace()?.name || '')} ${icon('down', 15)}</strong><small>${path === 'chat' ? `${workspace()?.members.length || 0} members · Team chat` : admin() ? 'Administrator workspace' : 'Team workspace'}</small></button>${admin() && path !== 'manage' ? `<button class="manage-link" data-nav="manage">${icon('manage', 15)} Manage${alertCount() ? ` <span class="count">${alertCount()}</span>` : ''}</button>` : ''}<button data-nav="profile" class="icon-btn" aria-label="Profile">${icon('user', 20)}</button></header>`; }
function bottomNav(path) { const tasksOn = path === 'tasks' || path.startsWith('task/'), shiftOn = path === 'shift' || path === 'handover'; return `<nav class="bottom-nav" aria-label="Main navigation"><button class="nav-button ${tasksOn ? 'active' : ''}" data-nav="tasks">${icon('tasks', 24)}<span>Tasks</span>${myTaskCount() ? `<span class="count">${myTaskCount()}</span>` : ''}</button><button class="nav-chat ${path === 'chat' ? 'active' : ''}" data-nav="chat" aria-label="Open team chat"><span class="nav-chat-circle">${icon('chat', 27)}</span><span>Chat</span></button><button class="nav-button ${shiftOn ? 'active' : ''}" data-nav="shift">${icon('clock', 24)}<span>Shift</span></button></nav>`; }
function desktopHead() { return `<header class="desktop-header"><div class="search">${icon('search')}<span>One shared conversation per workspace</span></div><div class="top-meta"><span class="badge ${connectionStatus === 'online' ? '' : 'amber'}">${icon('shield', 13)} ${connectionStatus === 'online' ? 'Connected' : 'Reconnecting'}</span><button data-nav="profile" class="icon-btn">${personAvatar(identity?.userId)} ${e(member(identity?.userId).name)} ${icon('down', 14)}</button></div></header>`; }
function workspaceMenu() { return !openWorkspaces ? '' : `<div class="workspace-menu" role="menu" aria-label="Your workspaces"><div class="eyebrow" style="padding:9px 11px">Switch workspace</div>${data.workspaces.map((w) => `<button class="workspace-option" data-action="switch-workspace" data-id="${e(w.id)}">${icon('coffee', 18)}<span class="grow"><strong>${e(w.name)}</strong><small>${e(w.type)}</small></span>${w.id === currentWorkspace ? icon('check', 16) : ''}</button>`).join('')}<button class="workspace-option" data-nav="workspace/create">${icon('plus', 17)}<strong>Create workspace</strong></button>${openWorkspaces ? `<button class="workspace-option" data-action="close-workspace-menu">${icon('back', 16)}<strong>Close</strong></button>` : ''}</div>`; }
function pageHeading(title, subtitle = '', extra = '') { return `<div class="page-heading"><div><h1>${e(title)}</h1>${subtitle ? `<p>${e(subtitle)}</p>` : ''}</div>${extra}</div>`; }
function taskStatus(status) { return ({ todo: badge('TO DO', 'blue'), doing: badge('DOING'), review: badge('NEEDS REVIEW', 'amber'), blocked: badge('BLOCKED', 'red'), done: badge('DONE') })[status] || badge(status); }
function taskCard(t) { return `<button class="task-card" data-nav="task/${encodeURIComponent(t.id)}"><div class="row between">${t.priority === 'high' ? badge('HIGH PRIORITY', 'red') : taskStatus(t.status)}${icon('chevron', 17, 'last-chevron')}</div><h3>${e(t.name)}</h3><p>${e(t.category[0].toUpperCase() + t.category.slice(1))} · Due ${e(t.due)}${t.assignee && admin() ? ' · ' + e(member(t.assignee).name) : ''}</p>${t.source ? `<span class="tiny muted">${icon('link', 13)} Linked to team chat</span>` : ''}</button>`; }
function empty(title, subtitle) { return `<div class="empty-state">${icon('check', 29)}<strong>${e(title)}</strong><p>${e(subtitle)}</p></div>`; }

// ── Screen renderers (preserved from original) ────────────────────

function taskScreen() {
  const mine = wsItems(data.tasks).filter((t) => t.assignee === identity?.userId);
  const shown = mine.filter((t) => t.status === currentTaskFilter || (currentTaskFilter === 'review' && t.status === 'blocked'));
  return `<section class="surface-page">${pageHeading('My Tasks', 'The work assigned to you', admin() ? `<button class="icon-btn" data-action="create-task" aria-label="Add a task">${icon('plus')}</button>` : '')}<div class="tab-row" role="tablist">${[['todo', 'To Do'], ['doing', 'Doing'], ['review', 'Needs Review'], ['done', 'Done']].map(([id, l]) => `<button class="tab ${currentTaskFilter === id ? 'active' : ''}" role="tab" aria-selected="${currentTaskFilter === id}" data-action="task-filter" data-id="${id}">${l}${id === 'todo' && myTaskCount() ? ` <span class="badge">${myTaskCount()}</span>` : ''}</button>`).join('')}</div><div class="task-grid">${shown.length ? shown.map(taskCard).join('') : empty('Nothing here right now', "Tasks will appear here when they're assigned.")}</div><div class="footer-note">WorkBuddy AI integration is available via manual analysis. Sample assignments are illustrative.</div></section>`;
}

function taskDetail(id) {
  const t = data.tasks.find((x) => x.id === id && x.ws === currentWorkspace);
  if (!t) return notFound();
  const source = data.messages.find((m) => m.id === t.source);
  return `<section class="surface-page"><button class="section-back" data-nav="tasks">${icon('back', 17)} My Tasks</button>${pageHeading(t.name, `Due ${e(t.due)}`, taskStatus(t.status))}<div class="two-col"><div class="stack"><div class="card"><div class="eyebrow">WHAT TO DO</div><p class="readable">${e(t.description)}</p><div class="divider"></div><div class="row between"><span class="muted small">Assigned to</span><span class="row">${personAvatar(t.assignee)} ${e(member(t.assignee).name)}</span></div><div class="divider"></div><div class="row between"><span class="muted small">Priority</span>${badge(t.priority.toUpperCase(), t.priority === 'high' ? 'red' : 'blue')}</div><div class="divider"></div><div class="row between"><span class="muted small">Verification</span><strong class="small">${t.verification === 'qualified' ? 'Qualified human review' : 'Self-report permitted'}</strong></div></div>${source ? `<div class="card"><div class="card-title">From team chat</div><div class="soft-panel">"${e(source.body)}"<br/><small>— ${e(member(source.user).name)} · ${displayTime(source.at)}</small></div><button class="text-btn" data-nav="chat">${icon('chat', 15)} Return to chat</button></div>` : ''}${(() => { const claims = wsItems(data.completionClaims).filter((c) => c.taskId === t.id); if (!claims.length) return ''; const claim = claims[0]; const claimMsg = data.messages.find((m) => m.id === claim.messageId); return `<div class="card"><div class="card-title">Chat completion evidence</div><div class="soft-panel"><strong>${e(claim.claimType)}</strong> — ${badge(claim.status.toUpperCase(), claim.status === 'rejected' ? 'red' : claim.status === 'pending_review' ? 'amber' : '')}<br/><small class="muted">Reported by ${e(member(claim.reportingEmployee).name)}</small><br/><small class="muted">Verification: ${e(claim.verificationApplied)}</small>${claimMsg ? `<div class="divider"></div><p>"${e(claimMsg.body)}"</p><small class="muted">— ${e(member(claimMsg.user).name)} · ${displayTime(claimMsg.at)}</small>` : ''}</div><div class="alert-panel" style="margin-top:9px"><small>${icon('shield', 14)} This is an employee self-attestation detected from chat, NOT independent proof of completion.${claim.verificationApplied === 'qualified' ? ' Qualified human verification is still required.' : ''}</small></div></div>`; })()}</div><div class="stack"><div class="card"><div class="card-title">Update this task</div><p class="muted small">Keep your team informed with a clear status.</p>${t.status === 'todo' ? `<button class="btn full" data-action="task-start" data-id="${e(t.id)}">${icon('check', 17)} Start task</button>` : ''}${['todo', 'doing'].includes(t.status) ? `<button class="btn ${t.status === 'doing' ? '' : 'outline'} full" style="margin-top:9px" data-action="task-complete" data-id="${e(t.id)}">${icon('check', 17)} Report complete</button><button class="btn outline full" style="margin-top:9px" data-action="task-blocked" data-id="${e(t.id)}">Can't do it</button>` : ''}${t.status === 'review' && admin() ? `<button class="btn full" style="margin-top:9px" data-action="task-verify" data-id="${e(t.id)}">${icon('check', 17)} Verify and approve</button>` : ''}${t.status === 'review' ? `<div class="soft-panel" style="margin-top:9px"><strong>Awaiting qualified review.</strong> Completion has been self-reported — this is <em>not</em> independent verification.</div>` : ''}${t.status === 'done' ? `<div class="soft-panel" style="margin-top:9px"><strong>${e(t.completion || 'Completed')}</strong>${t.verification === 'qualified' ? '<br/><small class="muted">Verified by administrator in this demo.</small>' : '<br/><small class="muted">Self-reported by the assignee.</small>'}</div>` : ''}${t.status === 'blocked' ? `<div class="alert-panel" style="margin-top:9px">${icon('alert', 17)} ${e(t.completion || 'This task needs manager attention.')}</div>` : ''}${admin() && t.status !== 'todo' ? `<button class="btn outline full" style="margin-top:9px" data-action="task-reopen" data-id="${e(t.id)}">Reopen task</button>` : ''}</div></div></div></section>`;
}

function chatScreen() {
  const messages = wsItems(data.messages).sort((a, b) => a.at - b.at);
  const activeAnnouncements = wsItems(data.announcements).filter((a) => a.status === 'published' && !a.archivedAt);
  const pinnedHtml = activeAnnouncements.length ? `<div class="pinned-notices">${activeAnnouncements.map((a) => {
    const acked = (a.acknowledgments || []).some((ack) => ack.personId === identity?.userId);
    return `<button class="pinned-notice ${a.type === 'safety' ? 'safety' : ''}" data-nav="announcement/${encodeURIComponent(a.id)}"><span class="pin-icon">${icon('pin', 14)}</span><div class="grow"><strong>${e(a.title)}</strong><small>${a.type === 'safety' ? 'Safety notice' : 'Notice'} · ${acked ? 'Acknowledged' : 'Tap to acknowledge'}</small></div>${icon('chevron', 15)}</button>`;
  }).join('')}</div>` : '';
  return `<div class="chat-shell"><header class="chat-head"><span class="avatar sea">${icon('users')}</span><div class="grow"><h1>${e(workspace()?.name || '')} · Team Chat</h1><small>One shared chat · ${workspace()?.members.length || 0} members</small></div>${badge('Work chat')}</header>${pinnedHtml}<div class="notice-chat">${icon('info', 13)} Work messages in this workspace may be analyzed for operational tasks when WorkBuddy AI is connected. Long-press or tap the dots to flag a message as an issue.</div><div class="chat-chat" id="chatMessages" role="log" aria-live="polite"><span class="day-label">${e(formatDate(Date.now()))}</span>${messages.map((m) => { const p = member(m.user), mine = m.user === identity?.userId; return `<div class="message ${mine ? 'mine' : ''}" data-message="${e(m.id)}">${personAvatar(m.user)}<div class="message-body">${!mine ? `<strong>${e(p.name)}</strong>` : ''}<p>${e(m.body)}</p><div class="message-meta">${displayTime(m.at)}${mine ? icon('doublecheck', 12) : ''}</div><button class="msg-dots-btn" data-action="flag-message" data-id="${e(m.id)}" aria-label="Flag this message">${icon('dots', 16)}</button></div></div>`; }).join('')}</div><div class="composer-wrap"><form id="send-message" class="composer" autocomplete="off"><button type="button" class="icon-btn" style="border:0" data-action="attach" aria-label="Attach photo">${icon('paperclip', 18)}</button><input type="text" name="message" maxlength="1500" placeholder="Message your team..." aria-label="Message your team" required/><button type="submit" class="send-button" aria-label="Send message">${icon('send', 18)}</button></form><input id="fileInput" type="file" accept="image/*" hidden/></div></div>`;
}

function shiftScreen() {
  const s = data.shifts[currentWorkspace] || { on: false, since: null };
  return `<section class="surface-page">${pageHeading('My Shift', 'Your attendance and shift handover')}<div class="stack"><div class="card"><div class="row"> <span class="avatar big sea">${icon('clock', 25)}</span><div class="grow"><strong>${s.on ? 'You are on shift' : 'Not clocked in'}</strong><p class="small muted" style="margin:6px 0 0">${s.on ? `Since ${displayTime(s.since)}` : 'Tap below to start your shift'}</p></div>${badge(s.on ? 'ON SHIFT' : 'OFF SHIFT', s.on ? '' : 'gray')}</div><button style="margin-top:19px" class="btn full ${s.on ? 'outline' : ''}" data-action="clock-toggle">${icon('clock', 18)} ${s.on ? 'Clock out' : 'Clock in'}</button><p class="field-help">Attendance records are stored in the shared backend.</p></div><div class="card"><div class="card-title">Today's schedule</div><div class="row muted small">${icon('calendar')} 8:00 AM – 4:00 PM · Example shift</div><div class="row muted small" style="margin-top:12px">${icon('coffee')} ${e(workspace()?.name || '')}</div></div><div class="card inline-list"><button class="list-row" data-nav="handover">${icon('file')}<span class="grow"><strong>Shift handover</strong><p>Share important updates with the next shift.</p></span>${icon('chevron', 17)}</button><button class="list-row" data-action="attendance-history">${icon('clock')}<span class="grow"><strong>Clock-in / out history</strong><p>View your demo activity.</p></span>${icon('chevron', 17)}</button></div></div></section>`;
}

function handoverScreen() {
  const existing = data.handovers[currentWorkspace] || {};
  const fields = [['finished', 'What did you finish?', 'e.g. Counter and morning prep completed'], ['problems', 'Any problems to report?', 'e.g. Machine 2 still needs inspection'], ['stock', 'Any stock concerns?', 'e.g. Four cartons of oat milk remain'], ['next', 'What should the next shift know?', 'Important updates or reminders'], ['unfinished', 'What is still unfinished?', 'e.g. Supplier delivery waiting']];
  return `<section class="surface-page"><button class="section-back" data-nav="shift">${icon('back', 17)} My Shift</button>${pageHeading('Shift Handover', 'A quick update for the next team')}<div class="soft-panel info-row">${icon('spark', 18)}<span>Suggested example text may be based on the sample workspace story. Review every answer yourself before submitting.</span></div><form id="handover-form" class="stack pad-top">${fields.map(([id, label, ph]) => `<div class="card field-group"><label for="h-${id}">${e(label)}</label><textarea id="h-${id}" class="textarea" name="${id}" rows="2" placeholder="${e(ph)}">${e(existing[id] || '')}</textarea></div>`).join('')}<div class="row"><button class="btn outline grow" type="button" data-action="handover-suggest">Fill sample suggestions</button><button class="btn grow" type="submit">${icon('check', 17)} Submit handover</button></div></form>${existing.saved ? `<div class="soft-panel pad-top">Last submitted: ${displayTime(existing.saved)}</div>` : ''}<p class="footer-note">Handovers are now saved to the shared backend.</p></section>`;
}

function profileScreen() {
  return `<section class="surface-page">${pageHeading('Profile & Workspaces', 'Your account preferences')}<div class="card"><div class="account-head">${personAvatar(identity?.userId, true)}<div><h2 style="margin:0 0 5px">${e(member(identity?.userId).name)}</h2><span class="muted small">${admin() ? 'Workspace administrator' : 'Team employee'} · Demo profile</span></div></div><div class="field-group"><label>Demo identity</label><p class="field-help">You are signed in as <strong>${e(member(identity?.userId).name)}</strong>. This is a simulated identity for the hackathon demo — it is <strong>not secure authentication</strong>.</p><button class="btn outline full" data-action="switch-identity">Switch demo identity</button></div></div><div class="section-title">My Workspaces</div><div class="card inline-list">${data.workspaces.map((w) => `<button class="list-row" data-action="switch-workspace" data-id="${e(w.id)}">${icon('coffee', 20)}<span class="grow"><strong>${e(w.name)}</strong><p>${e(w.type)}</p></span>${w.id === currentWorkspace ? icon('check', 19) : icon('chevron', 19)}</button>`).join('')}<button class="list-row" data-nav="workspace/create">${icon('plus')}<span class="grow"><strong>Create another workspace</strong></span>${icon('chevron', 17)}</button></div>${admin() ? `<div class="section-title">Administration</div><div class="card inline-list"><button class="list-row" data-nav="manage">${icon('manage')}<span class="grow"><strong>Manage ${e(workspace()?.name || '')}</strong><p>Issues, team, invites and AI settings</p></span>${icon('chevron', 17)}</button></div>` : ''}<p class="footer-note">Shared data is stored on the backend server. Your demo identity is stored locally on this device only.</p><button class="btn outline full" data-action="reset-demo">Reset demo data</button></section>`;
}

const managePages = [['attention', 'Needs Attention', 'alert', 'Review problems and approvals'], ['announcements', 'Announcements', 'megaphone', 'Publish notices and pinned alerts'], ['proposals', 'Silent AI Proposals', 'spark', 'AI-suggested tasks and reviews'], ['all-work', 'All Work', 'tasks', 'View every task and issue'], ['team', 'Team & Shifts', 'users', 'Members, roles and shift coverage'], ['invites', 'Invite Team', 'link', 'Invite employees to this workspace'], ['rules', 'AI & Rules', 'spark', 'Choose what AI may assign'], ['settings', 'Workspace Settings', 'settings', 'Business details and preferences']];

/** Render a single proposal card with evidence, reasoning, and approve/reject buttons. */
function proposalCard(p) {
  const typeLabels = { task_proposal: 'Task Proposal', completion_review: 'Completion Review', refusal: 'Protected Work Refusal', chat_completion_claim: 'Chat Completion Claim' };
  const typeBadge = { task_proposal: 'blue', completion_review: 'amber', refusal: 'red', chat_completion_claim: 'sea' };
  const confidenceLabel = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };
  const reviewed = p.status !== 'pending';
  const isProtected = p.type === 'completion_review' && (p.evidence || []).some((ev) => ev.toLowerCase().includes('qualified review') || ev.toLowerCase().includes('safety note'));
  return `<div class="proposal-card ${reviewed ? 'reviewed' : ''}"><div class="proposal-header"><span class="badge ${typeBadge[p.type] || ''}">${e(typeLabels[p.type] || p.type)}</span>${isProtected ? '<span class="badge red">PROTECTED</span>' : ''}${badge(confidenceLabel[p.confidence] || p.confidence, p.confidence === 'high' ? '' : 'amber')}${reviewed ? badge(p.status.toUpperCase(), p.status === 'approved' ? '' : 'red') : ''}</div><p class="proposal-summary">${e(p.summary)}</p>${p.evidence && p.evidence.length ? `<div class="proposal-evidence"><div class="eyebrow">EVIDENCE</div><ul>${p.evidence.map((item) => `<li>${e(item)}</li>`).join('')}</ul></div>` : ''}${p.reasoning ? `<div class="proposal-reasoning"><div class="eyebrow">AI REASONING</div><p>${e(p.reasoning)}</p></div>` : ''}${!reviewed ? `<div class="proposal-actions"><button class="btn" data-action="approve-proposal" data-id="${e(p.id)}">${icon('check', 16)} Approve</button><button class="btn outline" data-action="reject-proposal" data-id="${e(p.id)}">Reject</button></div>` : `<div class="proposal-reviewed-note"><small>Reviewed by ${e(p.reviewedBy || 'manager')} · ${p.reviewedAt ? displayTime(p.reviewedAt) : ''}</small></div>`}</div>`;
}

function manageHome() {
  const pendingProposals = wsItems(data.proposals).filter((p) => p.status === 'pending');
  const activeAnnouncements = wsItems(data.announcements).filter((a) => a.status === 'published' && !a.archivedAt);
  const ai = data.aiStatus;
  const aiLatest = ai?.latest;
  const aiAgg = ai?.aggregates;
  const aiStalled = ai?.stalled;
  const aiLastRun = aiLatest?.runAt ? displayTime(aiLatest.runAt) : 'Never';
  const aiCard = ai ? `<div class="card ai-monitor-card"><div class="row between"><div class="eyebrow">${icon('spark', 16)} SILENT AI MONITORING</div>${aiStalled ? badge('STALLED', 'red') : aiLatest ? badge('ACTIVE', '') : badge('NOT RUN', 'gray')}</div><div class="metric-grid" style="margin-top:12px"><div class="metric"><small>Last analysis</small><b style="font-size:13px">${e(aiLastRun)}</b></div><div class="metric"><small>Messages analyzed</small><b>${aiAgg?.totalMessagesAnalyzed || 0}</b></div><div class="metric"><small>Proposals created</small><b>${aiAgg?.totalProposalsCreated || 0}</b></div><div class="metric"><small>Completion claims</small><b>${aiAgg?.totalCompletionClaims || 0}</b></div></div>${aiLatest?.errors ? `<div class="alert-panel" style="margin-top:10px;padding:8px 12px;font-size:13px">${icon('alert', 14)} ${e(aiLatest.errors.slice(0, 150))}</div>` : ''}${aiLatest?.summary ? `<p class="small muted" style="margin-top:8px">${e(aiLatest.summary.slice(0, 200))}</p>` : ''}<p class="small muted" style="margin-top:8px">Scheduled hourly. The AI reads messages, proposes tasks, and processes completion claims — never posts to chat.</p></div>` : '';
  return `<section class="surface-page">${pageHeading('Manage', 'Keep your team running smoothly', badge(`${alertCount()} need attention`, alertCount() ? 'amber' : ''))}<div class="metric-grid"><div class="metric"><small>Active tasks</small><b>${wsItems(data.tasks).filter((t) => ['todo', 'doing'].includes(t.status)).length}</b>${badge('In progress', 'blue')}</div><div class="metric"><small>Open issues</small><b>${wsItems(data.issues).filter((i) => i.status !== 'resolved').length}</b>${badge('Needs follow-up', 'amber')}</div><div class="metric"><small>Awaiting review</small><b>${wsItems(data.tasks).filter((t) => ['review', 'blocked'].includes(t.status)).length}</b>${badge('Human review', 'red')}</div><div class="metric"><small>AI proposals</small><b>${pendingProposals.length}</b>${badge(pendingProposals.length ? 'Pending' : 'All clear', pendingProposals.length ? 'amber' : '')}</div><div class="metric"><small>Active announcements</small><b>${activeAnnouncements.length}</b>${badge(activeAnnouncements.length ? 'Published' : 'None', activeAnnouncements.length ? '' : 'gray')}</div></div>${aiCard}${pendingProposals.length > 0 ? `<h2 class="section-title">Silent AI Proposals</h2><div class="proposals-section">${pendingProposals.map(proposalCard).join('')}<button class="text-btn" data-nav="manage/proposals">View all proposals ${icon('chevron', 15)}</button></div>` : ''}<h2 class="section-title">Business tools</h2><div class="manage-list">${managePages.map(([id, title, ic, sub]) => `<button class="manage-tile" data-nav="manage/${id}"><span class="tile-icon ${id === 'attention' ? 'red' : ''}">${icon(ic, 20)}</span><strong>${e(title)}</strong><p>${e(sub)}</p>${id === 'proposals' && pendingProposals.length ? `<span class="count">${pendingProposals.length}</span>` : ''}</button>`).join('')}</div><p class="footer-note">The Silent AI agent monitors workspace activity and creates proposals for task creation, completion review, and protected work refusals. Managers review all proposals before any action is taken.</p></section>`;
}

function attentionScreen() {
  const open = wsItems(data.issues).filter((i) => i.status !== 'resolved');
  const pending = wsItems(data.tasks).filter((t) => ['review', 'blocked'].includes(t.status));
  return `<section class="surface-page"><button class="section-back" data-nav="manage">${icon('back', 17)} Manage</button>${pageHeading('Needs Attention', 'Only items that need a decision', badge(`${open.length + pending.length} pending`, 'amber'))}<h2 class="section-title">Open issues</h2><div class="stack">${open.length ? open.map((i) => `<button class="card list-row" data-nav="manage/issue/${e(i.id)}"><span class="avatar ${i.issueType === 'safety' ? 'red' : 'rose'}">${icon('alert')}</span><span class="grow"><strong>${e(i.title)}</strong><p>${e(i.description)}</p>${i.reporterId ? `<small class="muted">Reported by ${e(member(i.reporterId).name)}</small>` : ''}${i.issueType ? `<span class="badge blue" style="margin-left:6px">${e(i.issueType)}</span>` : ''}</span>${icon('chevron')}</button>`).join('') : empty('No open issues', 'Serious problems will appear here.')}</div><h2 class="section-title">Awaiting review</h2><div class="stack">${pending.length ? pending.map((t) => `<button class="card list-row" data-nav="task/${e(t.id)}"><span class="avatar orange">${icon('shield')}</span><span class="grow"><strong>${e(t.name)}</strong><p>Verification required · ${e(t.due)}</p></span>${icon('chevron')}</button>`).join('') : empty('Nothing to review', 'No approvals are pending right now.')}</div></section>`;
}

function proposalsScreen() {
  const proposals = wsItems(data.proposals);
  const pending = proposals.filter((p) => p.status === 'pending');
  const reviewed = proposals.filter((p) => p.status !== 'pending');
  return `<section class="surface-page"><button class="section-back" data-nav="manage">${icon('back', 17)} Manage</button>${pageHeading('Silent AI Proposals', 'AI-generated suggestions for your review', badge(`${pending.length} pending`, pending.length ? 'amber' : ''))}<div class="soft-panel info-row">${icon('spark', 18)}<span>The Silent AI agent monitors workspace activity and creates proposals for task creation, completion review, and protected work refusals. Review each proposal carefully before approving or rejecting.</span></div><h2 class="section-title">Pending (${pending.length})</h2><div class="proposals-section">${pending.length ? pending.map(proposalCard).join('') : empty('No pending proposals', 'The AI has no proposals waiting for review.')}</div>${reviewed.length ? `<h2 class="section-title">Reviewed (${reviewed.length})</h2><div class="proposals-section">${reviewed.map(proposalCard).join('')}</div>` : ''}</section>`;
}

function announcementsScreen() {
  const all = wsItems(data.announcements);
  const published = all.filter((a) => a.status === 'published' && !a.archivedAt);
  const archived = all.filter((a) => a.archivedAt);
  const drafts = all.filter((a) => a.status === 'draft');
  return `<section class="surface-page"><button class="section-back" data-nav="manage">${icon('back', 17)} Manage</button>${pageHeading('Announcements', 'Publish notices and pinned alerts', admin() ? `<button class="btn" data-action="compose-announcement">${icon('plus', 16)} New</button>` : '')}<div class="soft-panel info-row">${icon('megaphone', 18)}<span>Publish announcements visible to all workspace members. Safety notices linked to unresolved issues cannot be archived until the issue is resolved. The AI can draft announcements but only the manager can publish.</span></div>${drafts.length ? `<h2 class="section-title">Drafts (${drafts.length})</h2><div class="stack">${drafts.map(announcementCard).join('')}</div>` : ''}<h2 class="section-title">Active (${published.length})</h2><div class="stack">${published.length ? published.map(announcementCard).join('') : empty('No active announcements', 'Create a new announcement to pin it for your team.')}</div>${archived.length ? `<h2 class="section-title">Archived (${archived.length})</h2><div class="stack">${archived.map(announcementCard).join('')}</div>` : ''}</section>`;
}

function announcementCard(a) {
  const ackCount = (a.acknowledgments || []).length;
  const totalMembers = workspace()?.members?.length || 0;
  const isSafety = a.type === 'safety';
  const linkedIssue = a.linkedIssueId ? data.issues.find((i) => i.id === a.linkedIssueId) : null;
  const canArchive = !(isSafety && linkedIssue && linkedIssue.status === 'open');
  return `<button class="card announcement-card ${isSafety ? 'safety' : ''} ${a.archivedAt ? 'archived' : ''}" data-nav="announcement/${encodeURIComponent(a.id)}"><div class="row between"><div class="row" style="gap:8px"><span class="badge ${isSafety ? 'red' : 'blue'}">${icon(isSafety ? 'warning' : 'megaphone', 13)} ${e(a.type)}</span>${a.archivedAt ? badge('ARCHIVED', 'gray') : badge('PUBLISHED', '')}</div>${icon('chevron', 17)}</div><h3>${e(a.title)}</h3><p class="muted small">${e((a.body || '').slice(0, 120))}${(a.body || '').length > 120 ? '...' : ''}</p>${linkedIssue ? `<div class="soft-panel" style="margin-top:8px;padding:6px 10px"><small>${icon('link', 13)} Linked issue: ${e(linkedIssue.title)} — ${badge(linkedIssue.status.toUpperCase(), linkedIssue.status === 'open' ? 'red' : '')}</small></div>` : ''}<div class="row between" style="margin-top:8px"><small class="muted">${a.publishedAt ? displayTime(a.publishedAt) : 'Not published'} · By ${e(member(a.publisherId || a.createdBy).name)}</small><small class="muted">${ackCount}/${totalMembers} acknowledged</small></div></button>`;
}

function announcementDetailScreen(id) {
  const a = data.announcements.find((x) => x.id === id);
  if (!a) return notFound();
  const acks = a.acknowledgments || [];
  const myAck = acks.find((ack) => ack.personId === identity?.userId);
  const revisions = a.revisions || [];
  const linkedIssue = a.linkedIssueId ? data.issues.find((i) => i.id === a.linkedIssueId) : null;
  const isSafety = a.type === 'safety';
  const canArchive = admin() && !a.archivedAt && !(isSafety && linkedIssue && linkedIssue.status === 'open');
  return `<section class="surface-page"><button class="section-back" data-nav="${admin() ? 'manage/announcements' : 'chat'}">${icon('back', 17)} ${admin() ? 'Announcements' : 'Chat'}</button>${pageHeading(a.title, a.type === 'safety' ? 'Safety notice' : 'Team notice', badge(a.type.toUpperCase(), isSafety ? 'red' : 'blue'))}<div class="two-col"><div class="stack"><div class="card"><div class="card-title">Announcement</div><p class="readable">${e(a.body || '')}</p>${linkedIssue ? `<div class="soft-panel">${icon('link', 16)} <strong>Linked issue:</strong> ${e(linkedIssue.title)}<br/><small>${badge(linkedIssue.status.toUpperCase(), linkedIssue.status === 'open' ? 'red' : '')} ${e(linkedIssue.description || '')}</small></div>` : ''}<div class="divider"></div><div class="row between"><span class="muted small">Published by</span><span class="row">${personAvatar(a.publisherId || a.createdBy)} ${e(member(a.publisherId || a.createdBy).name)}</span></div>${a.publishedAt ? `<div class="row between" style="margin-top:8px"><span class="muted small">Published</span><small>${displayTime(a.publishedAt)}</small></div>` : ''}${a.archivedAt ? `<div class="row between" style="margin-top:8px"><span class="muted small">Archived</span><small>${displayTime(a.archivedAt)}</small></div>` : ''}</div>${revisions.length ? `<div class="card"><div class="card-title">Revision history (${revisions.length})</div>${revisions.map((r) => `<div class="soft-panel" style="margin-bottom:8px"><small>Edited by ${e(member(r.editorId).name)} · ${displayTime(r.editedAt)}</small>${r.oldTitle !== r.newTitle ? `<br/><small><s>${e(r.oldTitle)}</s> → <strong>${e(r.newTitle)}</strong></small>` : ''}</div>`).join('')}</div>` : ''}</div><div class="stack"><div class="card"><div class="card-title">Acknowledgments (${acks.length}/${workspace()?.members?.length || 0})</div>${acks.length ? `<div class="inline-list">${acks.map((ack) => `<div class="list-row">${personAvatar(ack.personId)}<span class="grow"><strong>${e(member(ack.personId).name)}</strong><small>Acknowledged ${displayTime(ack.acknowledgedAt)}</small></span>${icon('check', 16)}</div>`).join('')}</div>` : '<p class="muted">No acknowledgments yet.</p>'}${!myAck && !a.archivedAt && !admin() ? `<button class="btn full pad-top" data-action="ack-announcement" data-id="${e(a.id)}">${icon('check', 17)} Acknowledge this notice</button>` : myAck ? `<div class="soft-panel" style="margin-top:10px">${icon('check', 16)} You acknowledged this notice</div>` : ''}</div>${admin() && !a.archivedAt ? `<div class="card"><div class="card-title">Manager actions</div><div class="stack" style="gap:8px"><button class="btn outline full" data-action="edit-announcement" data-id="${e(a.id)}">${icon('edit', 16)} Edit announcement</button>${canArchive ? `<button class="btn outline full" data-action="archive-announcement" data-id="${e(a.id)}">${icon('archive', 16)} Archive announcement</button>` : `<div class="alert-panel">${icon('warning', 15)} Cannot archive: linked safety issue is still open. Resolve the issue first.</div>`}</div></div>` : ''}</div></div></section>`;
}

function allWorkScreen() {
  const tasks = wsItems(data.tasks).filter((t) => allWorkFilter === 'all' || t.status === allWorkFilter || (allWorkFilter === 'review' && t.status === 'blocked'));
  return `<section class="surface-page"><button class="section-back" data-nav="manage">${icon('back', 17)} Manage</button>${pageHeading('All Work', 'Tasks across your whole workspace', `<button class="btn" data-action="create-task">${icon('plus', 16)} Add task</button>`)}<div class="tab-row">${[['all', 'All'], ['todo', 'To Do'], ['doing', 'Doing'], ['review', 'Review'], ['done', 'Done']].map(([id, label]) => `<button class="tab ${allWorkFilter === id ? 'active' : ''}" data-action="all-filter" data-id="${id}">${label}</button>`).join('')}</div><div class="task-grid">${tasks.length ? tasks.map(taskCard).join('') : empty('No matching tasks', 'Try another filter.')}</div><h2 class="section-title">Issues</h2><div class="card inline-list">${wsItems(data.issues).map((i) => `<button class="list-row" data-nav="manage/issue/${e(i.id)}"><span class="avatar rose">${icon('alert')}</span><span class="grow"><strong>${e(i.title)}</strong><p>${e(i.status)} · ${e(i.severity)} priority</p></span>${icon('chevron', 18)}</button>`).join('') || '<p class="muted">No reported issues.</p>'}</div></section>`;
}

function teamScreen() {
  return `<section class="surface-page"><button class="section-back" data-nav="manage">${icon('back', 17)} Manage</button>${pageHeading('Team & Shifts', `${workspace()?.members.length || 0} people in this workspace`, `<button class="btn" data-nav="manage/invites">${icon('plus', 16)} Invite</button>`)}<div class="card inline-list">${workspace()?.members.map((id) => `<div class="list-row">${personAvatar(id)}<span class="grow"><strong>${e(member(id).name)}</strong><p>${e(member(id).role)}</p></span>${badge(id === identity?.userId ? 'You' : 'Member')}</div>`).join('') || '<p class="muted">No members.</p>'}</div><h2 class="section-title">Shift coverage</h2><div class="card"><div class="row between"><span class="row">${icon('clock')} Your shift</span>${badge(data.shifts[currentWorkspace]?.on ? 'Clocked in' : 'Off shift', data.shifts[currentWorkspace]?.on ? '' : 'gray')}</div><p class="small muted">Shift management is now backed by the shared server. Records are visible across devices.</p></div></section>`;
}

function rulesScreen(onboarding = false) {
  return `<section class="surface-page">${!onboarding ? `<button class="section-back" data-nav="manage">${icon('back', 17)} Manage</button>` : ''}${pageHeading('AI & Work Rules', 'Keep automation simple and safe')}<div class="soft-panel info-row">${icon('shield', 19)}<span>WorkBuddy AI analysis is manually triggered in this demo. These settings demonstrate which routine categories the administrator would allow WorkBuddy to assign automatically.</span></div><h2 class="section-title">Auto-assignment permissions</h2><div class="card inline-list">${workspace()?.rules.map((r) => `<div class="list-row"><span class="avatar ${r.allowed ? 'sea' : 'orange'}">${icon(r.locked ? 'lock' : 'tasks', 19)}</span><span class="grow"><strong>${e(r.name)}</strong><p>${e(r.note)}</p></span><button class="toggle ${r.allowed ? 'on' : ''}" type="button" role="switch" aria-label="Allow ${e(r.name)}" aria-checked="${r.allowed}" ${r.locked ? 'disabled' : ''} data-action="toggle-rule" data-id="${e(r.id)}"><i></i></button></div>`).join('') || ''}</div><div class="alert-panel pad-top">${icon('alert', 17)} Equipment repairs, spending and safety certification must never be silently authorized.</div>${onboarding ? `<button class="btn full pad-top" data-nav="chat">Finish setup · Go to chat</button>` : ''}</section>`;
}

function invitesScreen(onboarding = false) {
  return `<section class="surface-page">${!onboarding ? `<button class="section-back" data-nav="manage">${icon('back', 17)} Manage</button>` : ''}${pageHeading('Invite Team', 'Bring your employees into one shared conversation')}<div class="card"><div class="row"><span class="avatar big sea">${icon('users', 26)}</span><div><div class="card-title">Workspace invitation code</div><p class="muted small">Share this demonstration code with your team.</p></div></div><div class="link-card pad-top"><code class="grow">${e(workspace()?.invite || '')}</code><button class="icon-btn" data-action="copy-invite" aria-label="Copy invitation code">${icon('copy', 18)}</button></div><div class="row pad-top"><button class="btn grow" data-action="copy-invite">${icon('copy', 16)} Copy code</button><button class="btn outline grow" data-action="share-invite">${icon('link', 16)} Share link</button></div><p class="field-help">Demo only: invitations are illustrative in this prototype.</p></div><h2 class="section-title">How it works</h2><div class="card inline-list">${['Employee selects a demo identity on their phone', 'Employee opens the same backend URL', 'They enter this workspace\u2019s one shared chat'].map((s, i) => `<div class="list-row"><span class="avatar sea">${i + 1}</span><strong>${e(s)}</strong></div>`).join('')}</div>${onboarding ? `<button class="btn full pad-top" data-nav="workspace/rules">Continue to work rules ${icon('chevron', 17)}</button>` : ''}</section>`;
}

function settingsScreen() {
  return `<section class="surface-page"><button class="section-back" data-nav="manage">${icon('back', 17)} Manage</button>${pageHeading('Workspace Settings', 'Keep business details up to date')}<form id="settings-form" class="card"><div class="field-group"><label for="settings-name">Business name</label><input id="settings-name" class="field" name="name" maxlength="65" required value="${e(workspace()?.name || '')}"/></div><div class="field-group"><label for="settings-type">Business type</label><select id="settings-type" class="field" name="type">${['Café / Restaurant', 'Bakery', 'Retail / Mini-market', 'Service / Cleaning business', 'Printing / Production studio', 'Other business'].map((s) => `<option ${workspace()?.type === s ? 'selected' : ''}>${e(s)}</option>`).join('')}</select></div><div class="field-group"><label>Timezone</label><input class="field" value="Asia/Kuala_Lumpur (UTC+08:00)" disabled/><p class="field-help">Timezone is managed on the backend.</p></div><button class="btn full" type="submit">Save changes</button></form></section>`;
}

function issueScreen(id) {
  const i = data.issues.find((x) => x.id === id && x.ws === currentWorkspace);
  if (!i) return notFound();
  const source = data.messages.find((m) => m.id === i.source);
  const recentLinkedMessages = (i.linkedMessages || []).slice(-12);
  const issueTimeline = '<div class="card"><div class="card-title">Incident conversation (' + recentLinkedMessages.length + ')</div>' +
    (recentLinkedMessages.length ? recentLinkedMessages.map(m =>
      '<div class="soft-panel" style="margin-bottom:8px">' +
      '<small>' + e(member(m.user).name) + ' · ' + displayTime(m.at) + ' · ' + e(m.relation || 'report') + '</small>' +
      '<p class="readable">' + e(m.body) + '</p></div>').join('') :
      '<p class="muted">No linked messages yet.</p>') + '</div>';
  const lastFeedback = (data.agentFeedback || []).find(f => f.issueId === i.id);
  const feedbackCard = admin() && i.source
    ? '<div class="card"><div class="card-title">Teach Silent AI</div><p class="small muted">Was this detected incident report correct? Feedback is saved for evaluation; it does not retrain Tencent automatically.</p>' +
      (lastFeedback ? '<p class="muted small">Last review: ' + e(lastFeedback.verdict) + '</p>' : '') +
      '<div class="row" style="flex-wrap:wrap;gap:8px"><button class="btn outline" data-action="feedback-correct" data-id="' + e(i.id) + '">Correct report</button>' +
      '<button class="btn outline" data-action="feedback-false" data-id="' + e(i.id) + '">False alarm</button></div></div>' : '';
  const linkedAnn = i.linkedAnnouncementId ? data.announcements.find((a) => a.id === i.linkedAnnouncementId) : null;
  const stages = [
    { key: 'reported', label: 'Reported', done: true, detail: i.reporterId ? `By ${member(i.reporterId).name}` : 'Detected by AI' },
    { key: 'acknowledged', label: 'Acknowledged', done: i.approved || ['acknowledged','in_progress','resolved'].includes(i.status), detail: i.approved ? 'Manager acknowledged' : 'Pending' },
    { key: 'in_progress', label: 'Action in progress', done: ['in_progress', 'resolved'].includes(i.status), detail: '' },
    { key: 'qualified_verification', label: 'Qualified verification', done: i.status === 'resolved' && !!i.qualifiedVerifier, detail: i.qualifiedVerifier ? `By ${member(i.qualifiedVerifier).name}` : 'Required' },
    { key: 'resolved', label: 'Resolved', done: i.status === 'resolved', detail: i.verifiedAt ? displayTime(i.verifiedAt) : '' },
  ];
  return `<section class="surface-page"><button class="section-back" data-nav="manage/attention">${icon('back', 17)} Needs Attention</button>${pageHeading(i.title, 'Issue ' + i.id.toUpperCase(), badge(i.status.toUpperCase(), i.status !== 'resolved' ? 'red' : ''))}<div class="lifecycle-stages">${stages.map((s) => `<div class="lifecycle-stage ${s.done ? 'done' : ''}"><div class="lifecycle-dot ${s.done ? 'done' : ''}">${s.done ? icon('check', 12) : ''}</div><div class="grow"><strong>${e(s.label)}</strong>${s.detail ? `<small class="muted">${e(s.detail)}</small>` : ''}</div></div>`).join('')}</div><div class="two-col"><div class="stack"><div class="card"><div class="card-title">What was reported</div><p class="readable">${e(i.description)}</p>${i.issueType ? `<div class="soft-panel" style="margin-top:8px"><small>Type: ${e(i.issueType)}</small></div>` : ''}${source ? `<div class="soft-panel">"${e(source.body)}"<br/><small>— ${e(member(source.user).name)}</small></div>` : ''}${i.reporterId ? `<div class="row between" style="margin-top:8px"><span class="muted small">Reported by</span><span class="row">${personAvatar(i.reporterId)} ${e(member(i.reporterId).name)}</span></div>` : ''}<button class="text-btn pad-top" data-nav="chat">${icon('chat', 16)} See team chat</button></div>${issueTimeline}${linkedAnn ? `<div class="card"><div class="card-title">Linked announcement</div><button class="list-row" data-nav="announcement/${encodeURIComponent(linkedAnn.id)}">${icon('megaphone')}<span class="grow"><strong>${e(linkedAnn.title)}</strong><small>${badge(linkedAnn.type.toUpperCase(), linkedAnn.type === 'safety' ? 'red' : 'blue')}</small></span>${icon('chevron', 17)}</button></div>` : ''}</div><div class="stack"><div class="card"><div class="card-title">Why attention is needed</div><p class="muted readable">The report remains unverified. Follow-up messages, scheduled inspections and employee completion claims do not prove that equipment is safe or a fault is resolved.</p></div>${feedbackCard}<div class="card"><div class="card-title">Administrator decision</div>${i.status !== 'resolved' ? `<div class="alert-panel">Qualified inspection, safe-to-use confirmation and human authorization are required before closure.</div><button class="btn full pad-top" data-action="approve-inspection" data-id="${e(i.id)}">${icon('shield', 17)} Approve inspection request</button><button class="btn outline full" style="margin-top:10px" data-action="issue-resolve" data-id="${e(i.id)}">Record verified resolution</button>` : `<div class="soft-panel">This issue was recorded as resolved.${i.qualifiedVerifier ? `<br/><small>Verified by: ${e(member(i.qualifiedVerifier).name)}</small>` : ''}${i.verificationEvidence ? `<br/><small>Evidence: ${e(i.verificationEvidence)}</small>` : ''}${i.evidence ? `<br/><small>Notes: ${e(i.evidence)}</small>` : ''}</div>`}</div></div></div></section>`;
}

function createWorkspaceScreen() {
  return `<section class="surface-page">${pageHeading('Create Workspace', 'A dedicated home for your business')}<div class="step-head"><span class="step-dot on">1</span><span class="step-line"></span><span class="step-dot">2</span><span class="step-line"></span><span class="step-dot">3</span></div><form id="create-workspace-form" class="card"><div class="field-group"><label for="new-name">Business name</label><input id="new-name" class="field" name="name" required maxlength="65" placeholder="e.g. Daily Brew Café" /></div><div class="field-group"><label for="new-type">Business type</label><select id="new-type" name="type" class="field">${['Café / Restaurant', 'Bakery', 'Retail / Mini-market', 'Service / Cleaning business', 'Printing / Production studio', 'Other business'].map((s) => `<option>${e(s)}</option>`).join('')}</select></div><div class="field-group"><label>Timezone</label><input class="field" value="Malaysia / Singapore (UTC+08:00)" disabled /></div><div class="soft-panel">Your workspace will have one shared team chat, employee tasks, attendance, and owner-only management.</div><button class="btn full pad-top" type="submit">Create workspace & continue ${icon('chevron', 17)}</button></form></section>`;
}

function notFound() {
  return `<section class="surface-page">${pageHeading('Page not found', 'The page or record does not exist in this workspace.')}<button class="btn" data-nav="chat">Go to Chat</button></section>`;
}

// ── Identity selector screen (NEW — shown before the app) ────────

function identityScreen() {
  return `<div class="identity-screen"><div class="identity-card"><img src="./assets/mark.svg" alt="ShiftBridge" class="identity-logo"/><h1>Shift<span>Bridge</span></h1><p>Choose a demo identity for this device</p><div class="identity-list">${demoPeople.map((p) => `<button class="identity-option" data-action="select-identity" data-id="${e(p.id)}"><span class="avatar ${p.hue} big">${e(p.initials)}</span><span class="grow"><strong>${e(p.name)}</strong><small>${e(p.role)}</small></span>${icon('chevron', 17)}</button>`).join('')}</div><div class="identity-warning"><span>${icon('shield', 16)} This is a simulated demo identity for the DORMATHON hackathon. It is <strong>not secure authentication</strong>. Do not use this backend on the public internet.</span></div></div></div>`;
}

// ── Loading screen ────────────────────────────────────────────────

function loadingScreen() {
  return `<div class="identity-screen"><div class="identity-card"><img src="./assets/mark.svg" alt="ShiftBridge" class="identity-logo"/><h1>Shift<span>Bridge</span></h1><div class="loading-dots"><span></span><span></span><span></span></div><p>Connecting to backend...</p></div></div>`;
}

// ── Dialog popup ──────────────────────────────────────────────────

function popup() {
  if (!activeDialog) return '';
  if (activeDialog === 'task') {
    return `<div class="dialog-backdrop"><form class="dialog" id="new-task-form" role="dialog" aria-modal="true"><h2>Add a task</h2><p>Create an assignment for this workspace. WorkBuddy AI task creation is manually triggered.</p><div class="field-group"><label for="task-name">Task name</label><input id="task-name" class="field" name="name" maxlength="100" required placeholder="e.g. Check paper cups" autofocus /></div><div class="field-group"><label for="task-description">Instructions</label><textarea id="task-description" class="textarea" name="description" placeholder="What needs doing?"></textarea></div><div class="field-group"><label>Assign to</label><select class="field" name="assignee">${workspace()?.members.map((id) => `<option value="${e(id)}" ${id === identity?.userId ? 'selected' : ''}>${e(member(id).name)}</option>`).join('') || ''}</select></div><div class="row actions"><button type="button" class="btn outline" data-action="close-dialog">Cancel</button><button type="submit" class="btn">Add task</button></div></form></div>`;
  }
  if (activeDialog === 'flag-issue') {
    const msg = data.messages.find((m) => m.id === flagMsgId && m.ws === currentWorkspace);
    const msgPreview = msg ? `"${msg.body.slice(0, 80)}${msg.body.length > 80 ? '...' : ''}" — ${member(msg.user).name}` : '';
    return `<div class="dialog-backdrop"><form class="dialog" id="flag-issue-form" role="dialog" aria-modal="true"><h2>${icon('flag', 18)} Flag as issue</h2><p>Report this message as an operational problem that needs attention.</p>${msgPreview ? `<div class="soft-panel">${e(msgPreview)}</div>` : ''}<div class="field-group"><label for="issue-title">Issue title</label><input id="issue-title" class="field" name="title" maxlength="100" required placeholder="e.g. Equipment problem reported" autofocus /></div><div class="field-group"><label for="issue-desc">Description</label><textarea id="issue-desc" class="textarea" name="description" rows="3" placeholder="What is the problem?"></textarea></div><div class="field-group"><label for="issue-type">Issue type</label><select id="issue-type" class="field" name="issueType"><option value="equipment">Equipment</option><option value="safety">Safety</option><option value="supply">Supply / Stock</option><option value="facility">Facility</option><option value="other">Other</option></select></div><div class="row actions"><button type="button" class="btn outline" data-action="close-dialog">Cancel</button><button type="submit" class="btn">Flag issue</button></div></form></div>`;
  }
  if (activeDialog === 'compose-announcement') {
    const draftTitle = pendingAnnouncementDraft?.title || '';
    const draftBody = pendingAnnouncementDraft?.body || '';
    const draftType = pendingAnnouncementDraft?.type || 'general';
    const draftLinkedIssue = pendingAnnouncementDraft?.linkedIssueId || '';
    const openIssues = wsItems(data.issues).filter((i) => i.status === 'open');
    return `<div class="dialog-backdrop"><form class="dialog" id="announcement-form" role="dialog" aria-modal="true"><h2>${icon('megaphone', 18)} New announcement</h2><p>Publish a notice visible to all workspace members. Safety notices pinned to chat until archived.</p>${pendingAnnouncementDraft?.aiGenerated ? `<div class="soft-panel">${icon('spark', 15)} <small>AI draft suggested. Review and edit before publishing.</small></div>` : ''}<div class="field-group"><label for="ann-title">Title</label><input id="ann-title" class="field" name="title" maxlength="150" required value="${e(draftTitle)}" placeholder="e.g. Machine 2 out of service" autofocus /></div><div class="field-group"><label for="ann-body">Body</label><textarea id="ann-body" class="textarea" name="body" rows="4" required placeholder="Write the announcement content...">${e(draftBody)}</textarea></div><div class="field-group"><label for="ann-type">Type</label><select id="ann-type" class="field" name="type"><option value="general" ${draftType === 'general' ? 'selected' : ''}>General notice</option><option value="safety" ${draftType === 'safety' ? 'selected' : ''}>Safety alert</option><option value="operational" ${draftType === 'operational' ? 'selected' : ''}>Operational update</option></select></div>${openIssues.length ? `<div class="field-group"><label for="ann-linked">Link to issue (optional)</label><select id="ann-linked" class="field" name="linkedIssueId"><option value="">No linked issue</option>${openIssues.map((i) => `<option value="${e(i.id)}" ${draftLinkedIssue === i.id ? 'selected' : ''}>${e(i.title)}</option>`).join('')}</select></div>` : ''}<div class="row actions"><button type="button" class="btn outline" data-action="close-dialog">Cancel</button><button type="submit" class="btn">Publish</button></div></form></div>`;
  }
  if (activeDialog === 'edit-announcement') {
    const a = data.announcements.find((x) => x.id === pendingAnnouncementId);
    if (!a) { activeDialog = ''; return ''; }
    return `<div class="dialog-backdrop"><form class="dialog" id="edit-announcement-form" role="dialog" aria-modal="true"><h2>${icon('edit', 18)} Edit announcement</h2><p>Editing creates a revision record. The previous version is preserved in the revision history.</p><div class="field-group"><label for="edit-ann-title">Title</label><input id="edit-ann-title" class="field" name="title" maxlength="150" required value="${e(a.title)}" autofocus /></div><div class="field-group"><label for="edit-ann-body">Body</label><textarea id="edit-ann-body" class="textarea" name="body" rows="4" required>${e(a.body || '')}</textarea></div><div class="row actions"><button type="button" class="btn outline" data-action="close-dialog">Cancel</button><button type="submit" class="btn">Save changes</button></div></form></div>`;
  }
  if (activeDialog === 'resolve') {
    return `<div class="dialog-backdrop"><form class="dialog" id="resolve-form" role="dialog" aria-modal="true"><h2>Record verified resolution</h2><p>Only record a genuine inspection and safe-to-use confirmation. This demo does not certify equipment safety.</p><div class="field-group"><label>How was it verified?</label><textarea class="textarea" name="proof" required placeholder="Qualified verifier, inspection result, and date"></textarea></div><div class="field-group"><label>Verification evidence</label><textarea class="textarea" name="evidence" rows="2" placeholder="e.g. Technician report #TR-2026, safety inspection certificate"></textarea></div><div class="row actions"><button class="btn outline" type="button" data-action="close-dialog">Cancel</button><button class="btn" type="submit">Record resolution</button></div></form></div>`;
  }
  if (activeDialog === 'reset') {
    return `<div class="dialog-backdrop"><div class="dialog" role="dialog" aria-modal="true"><h2>Reset demonstration?</h2><p>This will reset the shared backend to its initial demo state. All phones connected to this server will see the reset data.</p><div class="row actions"><button class="btn outline" data-action="close-dialog">Cancel</button><button class="btn danger" data-action="confirm-reset">Reset demo</button></div></div></div>`;
  }
  return '';
}

function notify(message) { toast = message; render(); setTimeout(() => { if (toast === message) { toast = ''; const n = $('.notification'); if (n) n.remove(); } }, 3300); }

// ── Main render function ───────────────────────────────────────────

function render() {
  // Identity gate: if no identity selected, show selector.
  if (!identity) {
    app.innerHTML = identityScreen();
    return;
  }
  // Loading gate: wait for initial data load.
  if (loading) {
    app.innerHTML = loadingScreen();
    return;
  }

  try {
    let path = route();
    if (!admin() && (path.startsWith('manage/') || path === 'manage' || path === 'workspace/rules' || path === 'workspace/invite')) path = 'chat';
    let view;
    if (path === 'chat') view = chatScreen();
    else if (path === 'tasks') view = taskScreen();
    else if (path.startsWith('task/')) view = taskDetail(path.split('/')[1]);
    else if (path === 'shift') view = shiftScreen();
    else if (path === 'handover') view = handoverScreen();
    else if (path === 'profile') view = profileScreen();
    else     if (path === 'manage') view = manageHome();
    else if (path === 'manage/attention') view = attentionScreen();
    else if (path === 'manage/announcements') view = announcementsScreen();
    else if (path === 'manage/proposals') view = proposalsScreen();
    else if (path === 'manage/all-work') view = allWorkScreen();
    else if (path === 'manage/team') view = teamScreen();
    else if (path === 'manage/rules') view = rulesScreen();
    else if (path === 'manage/invites') view = invitesScreen();
    else if (path === 'manage/settings') view = settingsScreen();
    else if (path.startsWith('manage/issue/')) view = issueScreen(path.split('/')[2]);
    else if (path.startsWith('announcement/')) view = announcementDetailScreen(path.split('/')[1]);
    else if (path === 'workspace/create') view = createWorkspaceScreen();
    else if (path === 'workspace/invite') view = invitesScreen(true);
    else if (path === 'workspace/rules') view = rulesScreen(true);
    else view = notFound();

    app.innerHTML = `<div class="app-frame">${sideBar(path)}<div class="content-wrap">${desktopHead()}${mobileHeader(path)}<main class="app-main">${view}</main>${bottomNav(path)}</div></div>${workspaceMenu()}${popup()}${toast ? `<div class="notification" role="status">${e(toast)}</div>` : ''}`;

    if (path === 'chat') { const logs = $('#chatMessages'); if (logs) logs.scrollTop = logs.scrollHeight; }
    if (lastRoute !== path) lastRoute = path;
  } catch (renderErr) {
    console.error('Render error:', renderErr);
    app.innerHTML = `<div class="identity-screen"><div class="identity-card"><h1>Something went wrong</h1><p>${e(renderErr.message)}</p><button class="btn full" data-action="switch-identity">Back to identity selector</button><p class="footer-note" style="margin-top:12px">Try refreshing the page, or reset demo data from the identity screen.</p></div></div>`;
  }
}

// ── Event handlers ─────────────────────────────────────────────────

window.addEventListener('hashchange', () => { openWorkspaces = false; render(); });

app.addEventListener('click', async (event) => {
  const el = event.target.closest('button[data-nav],button[data-action]');
  if (!el) return;

  if (el.dataset.nav) { openWorkspaces = false; activeDialog = ''; nav(el.dataset.nav); return; }

  const action = el.dataset.action;
  const id = el.dataset.id;

  // ── Identity selection ──────────────────────────────────────────
  if (action === 'select-identity') {
    setIdentity(id);
    identity = getIdentity();
    await loadAllData();
    loading = false;
    render();
    startSync();
    notify(`Signed in as ${member(id).name}`);
    return;
  }

  if (action === 'switch-identity') {
    clearIdentity();
    identity = null;
    stopSync();
    if (sseCleanup) { sseCleanup(); sseCleanup = null; }
    location.hash = '';
    render();
    return;
  }

  // ── Workspace menu ───────────────────────────────────────────────
  if (action === 'workspace-menu') { openWorkspaces = !openWorkspaces; render(); return; }
  if (action === 'close-workspace-menu') { openWorkspaces = false; render(); return; }
  if (action === 'switch-workspace') {
    if (data.workspaces.some((w) => w.id === id)) {
      currentWorkspace = id;
      openWorkspaces = false;
      nav('chat');
      notify(`Switched to ${workspace().name}`);
      refreshWorkspaceData();
    }
    return;
  }
  if (action === 'back') { history.length > 1 ? history.back() : nav('chat'); return; }
  if (action === 'task-filter') { currentTaskFilter = id; render(); return; }
  if (action === 'all-filter') { allWorkFilter = id; render(); return; }
  if (action === 'create-task') { activeDialog = 'task'; render(); return; }
  if (action === 'close-dialog') { activeDialog = ''; render(); return; }
  if (action === 'reset-demo') { activeDialog = 'reset'; render(); return; }

  if (action === 'confirm-reset') {
    try {
      await api.reset();
      await loadAllData();
      activeDialog = '';
      nav('chat');
      notify('Demo data reset on the server');
    } catch (err) { notify('Reset failed: ' + err.message); }
    return;
  }

  // ── Task status updates (API calls) ─────────────────────────────
  if (action === 'task-start' || action === 'task-complete' || action === 'task-verify' || action === 'task-blocked' || action === 'task-reopen') {
    const t = data.tasks.find((x) => x.id === id && x.ws === currentWorkspace);
    if (!t) return;
    if (!admin() && t.assignee !== identity?.userId) return notify('You can only update your own tasks.');

    let newStatus = t.status;
    let newCompletion = t.completion || '';

    if (action === 'task-start') { newStatus = 'doing'; }
    if (action === 'task-complete') {
      newStatus = t.verification === 'qualified' ? 'review' : 'done';
      newCompletion = t.verification === 'qualified' ? 'Awaiting qualified review' : 'Self-reported done';
    }
    if (action === 'task-verify') {
      if (!admin()) return;
      newStatus = 'done';
      newCompletion = 'Verified by demo administrator';
    }
    if (action === 'task-blocked') {
      newStatus = 'blocked';
      newCompletion = 'Blocked — manager attention required';
    }
    if (action === 'task-reopen' && admin()) {
      newStatus = 'todo';
      newCompletion = '';
    }

    // Optimistic update.
    t.status = newStatus;
    t.completion = newCompletion;
    render();

    try {
      await api.updateTask(id, { status: newStatus, completion: newCompletion, actor: identity.userId });
      notify(action === 'task-blocked' ? 'Task sent for review' : 'Task updated');
    } catch (err) {
      notify('Update failed: ' + err.message);
      await refreshTasks();
    }
    return;
  }

  // ── Toggle rule ─────────────────────────────────────────────────
  if (action === 'toggle-rule') {
    const rule = workspace()?.rules.find((r) => r.id === id);
    if (rule && !rule.locked) {
      rule.allowed = !rule.allowed;
      render();
      try {
        await api.updateRule(id, rule.allowed);
        notify(`${rule.name}: ${rule.allowed ? 'allowed' : 'review required'}`);
      } catch (err) {
        notify('Update failed: ' + err.message);
        await refreshWorkspaces();
      }
    }
    return;
  }

  // ── Approve / reject AI proposal ─────────────────────────────────
  if (action === 'approve-proposal' || action === 'reject-proposal') {
    if (!admin()) return notify('Only administrators can review AI proposals.');
    const decision = action === 'approve-proposal' ? 'approve' : 'reject';
    const prop = data.proposals.find((p) => p.id === id);

    // Check if this is a protected completion_review that needs qualified evidence.
    // The MCP server adds evidence strings containing "qualified review" or
    // "SAFETY NOTE" for protected tasks.
    const isProtectedCompletion = decision === 'approve' && prop && prop.type === 'completion_review' &&
      ((prop.evidence || []).some((e) => e.toLowerCase().includes('qualified review') || e.toLowerCase().includes('safety note')) ||
       (prop.reasoning || '').toLowerCase().includes('qualified verification'));

    // Prompt for qualified verification evidence for protected tasks.
    let qualifiedVerification = '';
    if (isProtectedCompletion) {
      qualifiedVerification = (window.prompt(
        'PROTECTED TASK — Qualified Verification Required\n\n' +
        'This completion claim is for a protected task (repairs, purchases, or safety).\n' +
        'To mark the task as DONE, you must provide qualified verification evidence.\n' +
        'If you approve without evidence, the task will remain in REVIEW.\n\n' +
        'Enter verification evidence (e.g., "Technician report #TR-2026, safety inspection passed"):',
        ''
      ) || '').trim();
    }

    // Optimistic update.
    if (prop) {
      prop.status = decision === 'approve' ? 'approved' : 'rejected';
      prop.reviewedBy = identity.userId;
      prop.reviewedAt = Date.now();
      render();
    }
    try {
      const body = { decision, reviewer: identity.userId };
      if (qualifiedVerification) body.qualifiedVerification = qualifiedVerification;
      await api.reviewProposal(id, body);
      if (isProtectedCompletion && !qualifiedVerification) {
        notify('Approved — task remains in REVIEW. Qualified verification evidence required to mark done.');
      } else if (isProtectedCompletion && qualifiedVerification) {
        notify('Approved — task marked DONE with qualified verification evidence.');
      } else {
        notify(decision === 'approve' ? 'Proposal approved' : 'Proposal rejected');
      }
      // Refresh tasks since approving a task_proposal creates a task,
      // and approving/rejecting a completion_review changes task status.
      await Promise.all([refreshTasks(), refreshProposals()]);
      render();
    } catch (err) {
      notify('Review failed: ' + err.message);
      await refreshProposals();
      render();
    }
    return;
  }

  // ── Agent V2: manager evaluates a detected incident ───────────────
  if (action === 'feedback-correct' || action === 'feedback-false') {
    if (!admin()) return notify('Only the manager can review AI detections.');
    const issue = data.issues.find(item => item.id === id && item.ws === currentWorkspace);
    if (!issue?.source) return notify('Issue has no verified source message.');
    try {
      await api.submitAgentFeedback(currentWorkspace, {
        reviewerId:identity.userId,issueId:id,messageId:issue.source,
        verdict:action === 'feedback-correct' ? 'correct_issue' : 'false_alarm',
        note:'Manager reviewed the original reported issue',
      });
      await refreshAgentFeedback();
      render();
      notify('AI feedback recorded for future evaluations');
    } catch (err) { notify('Feedback failed: ' + err.message); }
    return;
  }

  // ── Approve inspection ───────────────────────────────────────────
  if (action === 'approve-inspection') {
    const i = data.issues.find((x) => x.id === id && x.ws === currentWorkspace);
    if (i) {
      i.approved = true;
      render();
      try {
        await api.updateIssue(id, { approved: true, actor: identity.userId });
        notify('Inspection request approved in this demo — no real booking made.');
      } catch (err) {
        notify('Update failed: ' + err.message);
        await refreshIssues();
      }
    }
    return;
  }

  // ── Issue resolve ────────────────────────────────────────────────
  if (action === 'issue-resolve') {
    if (!admin()) return;
    pendingIssueId = id;
    activeDialog = 'resolve';
    render();
    return;
  }

  // ── Flag message as issue (Phase 6) ──────────────────────────────
  if (action === 'flag-message') {
    flagMsgId = id;
    activeDialog = 'flag-issue';
    render();
    return;
  }

  // ── Compose announcement (Phase 6) ──────────────────────────────
  if (action === 'compose-announcement') {
    if (!admin()) return notify('Only administrators can publish announcements.');
    pendingAnnouncementDraft = null;
    activeDialog = 'compose-announcement';
    render();
    return;
  }

  // Acknowledge announcement (Phase 6)
  if (action === 'ack-announcement') {
    try {
      await api.acknowledgeAnnouncement(id);
      await refreshAnnouncements();
      notify('Announcement acknowledged');
    } catch (err) { notify('Ack failed: ' + err.message); }
    return;
  }

  // Edit announcement (Phase 6)
  if (action === 'edit-announcement') {
    if (!admin()) return;
    pendingAnnouncementId = id;
    activeDialog = 'edit-announcement';
    render();
    return;
  }

  // Archive announcement (Phase 6)
  if (action === 'archive-announcement') {
    if (!admin()) return;
    try {
      await api.archiveAnnouncement(id);
      await refreshAnnouncements();
      notify('Announcement archived');
    } catch (err) { notify('Archive failed: ' + err.message); }
    return;
  }

  // ─<arg_value>─ Copy / share invite ──────────────────────────────────────────
  if (action === 'copy-invite' || action === 'share-invite') {
    const str = action === 'copy-invite' ? (workspace()?.invite || '') : `${location.origin}${location.pathname}#/profile?invite=${encodeURIComponent(workspace()?.invite || '')}`;
    try { await navigator.clipboard.writeText(str); notify('Demo invite copied'); } catch { notify(`Demo code: ${workspace()?.invite || ''}`); }
    return;
  }

  // ── Handover suggestions ─────────────────────────────────────────
  if (action === 'handover-suggest') {
    const suggestions = {
      finished: 'Checked inventory and prepared the counter.',
      problems: 'Machine 2 is awaiting qualified inspection. Do not use it until cleared.',
      stock: 'Four cartons of oat milk remain, according to the sample team chat.',
      next: 'Follow up on equipment inspection and check morning stock.',
      unfinished: 'Confirm inspection and required safe-to-use sign-off.',
    };
    for (const [k, v] of Object.entries(suggestions)) {
      const field = document.getElementById(`h-${k}`);
      if (field && !field.value.trim()) field.value = v;
    }
    notify('Sample suggestions added — please review each one');
    return;
  }

  if (action === 'attendance-history') { notify('Clock-in/out history is available via the backend API.'); return; }
  if (action === 'attach') { document.querySelector('#fileInput')?.click(); return; }
});

// ── Form submissions ──────────────────────────────────────────────

app.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const fields = Object.fromEntries(new FormData(form).entries());

  // ── Send message ─────────────────────────────────────────────────
  if (form.id === 'send-message') {
    const body = String(fields.message || '').trim();
    if (!body) return;
    const msgId = safeID('m');
    const msg = { id: msgId, ws: currentWorkspace, user: identity.userId, body: body.slice(0, 1500), at: Date.now() };
    // Optimistic update.
    data.messages.push(msg);
    render();
    document.querySelector('#send-message input[name="message"]')?.focus();
    try {
      await api.sendMessage(currentWorkspace, { id: msgId, user: identity.userId, body: body.slice(0, 1500) });
    } catch (err) {
      notify('Message failed to send: ' + err.message);
      // Remove optimistic message on failure.
      data.messages = data.messages.filter((m) => m.id !== msgId);
      render();
    }
    return;
  }

  // ── Create task ──────────────────────────────────────────────────
  if (form.id === 'new-task-form') {
    const name = String(fields.name || '').trim();
    if (!name) return;
    const taskId = safeID('t');
    const task = {
      id: taskId, ws: currentWorkspace, name: name.slice(0, 100),
      description: String(fields.description || '').slice(0, 1000),
      assignee: String(fields.assignee || identity.userId), status: 'todo',
      priority: 'normal', category: 'routine', due: 'Today', source: null,
      createdBy: identity.userId, verification: 'self-report', completion: '',
    };
    // Optimistic update.
    data.tasks.unshift(task);
    activeDialog = '';
    currentTaskFilter = 'todo';
    nav('tasks');
    try {
      await api.createTask(currentWorkspace, {
        id: taskId, name: name.slice(0, 100), description: String(fields.description || '').slice(0, 1000),
        assignee: String(fields.assignee || identity.userId), createdBy: identity.userId,
      });
      notify('Task added to the workspace');
    } catch (err) {
      notify('Task creation failed: ' + err.message);
      await refreshTasks();
    }
    return;
  }

  // ── Handover form ────────────────────────────────────────────────
  if (form.id === 'handover-form') {
    const handover = {
      finished: fields.finished || '', problems: fields.problems || '',
      stock: fields.stock || '', next: fields.next || '', unfinished: fields.unfinished || '',
    };
    data.handovers[currentWorkspace] = { ...handover, saved: Date.now() };
    render();
    try {
      await api.saveHandover(currentWorkspace, handover);
      notify('Handover saved to the shared backend');
    } catch (err) {
      notify('Save failed: ' + err.message);
    }
    return;
  }

  // ── Settings form ────────────────────────────────────────────────
  if (form.id === 'settings-form') {
    if (!admin()) return;
    const name = String(fields.name || '').trim().slice(0, 65);
    const type = String(fields.type || 'Other business');
    const ws = workspace();
    if (ws) { ws.name = name; ws.type = type; }
    render();
    try {
      await api.updateWorkspace(ws.id, { name, type });
      notify('Workspace details updated on the server');
    } catch (err) {
      notify('Update failed: ' + err.message);
      await refreshWorkspaces();
    }
    return;
  }

  // ── Create workspace ─────────────────────────────────────────────
  if (form.id === 'create-workspace-form') {
    const name = String(fields.name || '').trim();
    if (!name) return;
    try {
      const result = await api.createWorkspace({ name: name.slice(0, 65), type: String(fields.type || 'Other business'), creatorId: identity.userId });
      await refreshWorkspaces();
      currentWorkspace = result.id;
      nav('workspace/invite');
      notify('Workspace created on the server');
    } catch (err) {
      notify('Creation failed: ' + err.message);
    }
    return;
  }

  // ── Resolve form ─────────────────────────────────────────────────
  if (form.id === 'resolve-form') {
    const text = String(fields.proof || '').trim();
    if (!text) return;
    const evidence = String(fields.evidence || '').trim();
    const i = data.issues.find((x) => x.id === pendingIssueId && x.ws === currentWorkspace && x.status !== 'resolved');
    if (i) {
      i.status = 'resolved';
      i.evidence = text.slice(0, 1000);
      i.qualifiedVerifier = identity.userId;
      i.verificationEvidence = evidence.slice(0, 1000);
      i.verifiedAt = Date.now();
      render();
    }
    activeDialog = '';
    try {
      await api.resolveIssue(pendingIssueId, {
        verifier: identity.userId,
        evidence: evidence.slice(0, 1000),
        notes: text.slice(0, 1000),
        actor: identity.userId,
      });
      await refreshIssues();
      notify('Resolution recorded with qualified verification — not independently certified');
    } catch (err) {
      notify('Update failed: ' + err.message);
      await refreshIssues();
    }
    return;
  }

  // ── Flag issue from chat message (Phase 6) ───────────────────────
  if (form.id === 'flag-issue-form') {
    const title = String(fields.title || '').trim();
    if (!title) return;
    const description = String(fields.description || '').trim();
    const issueType = String(fields.issueType || 'equipment');
    activeDialog = '';
    try {
      await api.reportIssue(currentWorkspace, {
        messageId: flagMsgId,
        reporterId: identity.userId,
        title: title.slice(0, 100),
        description: description.slice(0, 1000),
        issueType,
      });
      await refreshIssues();
      notify('Issue reported from chat message');
    } catch (err) {
      notify('Flag failed: ' + err.message);
    }
    flagMsgId = null;
    return;
  }

  // ── Publish announcement (Phase 6) ───────────────────────────────
  if (form.id === 'announcement-form') {
    if (!admin()) return;
    const title = String(fields.title || '').trim();
    const body = String(fields.body || '').trim();
    if (!title || !body) return;
    const type = String(fields.type || 'general');
    const linkedIssueId = String(fields.linkedIssueId || '').trim() || null;
    activeDialog = '';
    try {
      await api.createAnnouncement(currentWorkspace, {
        title: title.slice(0, 150),
        body: body.slice(0, 5000),
        type,
        linkedIssueId,
        publisherId: identity.userId,
        createdBy: identity.userId,
      });
      await refreshAnnouncements();
      notify('Announcement published');
    } catch (err) {
      notify('Publish failed: ' + err.message);
    }
    pendingAnnouncementDraft = null;
    return;
  }

  // ── Edit announcement (Phase 6) ─────────────────────────────────
  if (form.id === 'edit-announcement-form') {
    if (!admin()) return;
    const title = String(fields.title || '').trim();
    const body = String(fields.body || '').trim();
    if (!title || !body) return;
    activeDialog = '';
    try {
      await api.updateAnnouncement(pendingAnnouncementId, {
        title: title.slice(0, 150),
        body: body.slice(0, 5000),
        editorId: identity.userId,
      });
      await refreshAnnouncements();
      notify('Announcement updated — revision saved');
    } catch (err) {
      notify('Edit failed: ' + err.message);
    }
    pendingAnnouncementId = null;
    return;
  }
});

// ── File input change ─────────────────────────────────────────────
app.addEventListener('change', (event) => {
  if (event.target.id === 'fileInput') {
    const f = event.target.files?.[0];
    if (f) notify('Photo uploads require backend file storage. No file was sent.');
    event.target.value = '';
  }
});

// ── Data loading & sync ────────────────────────────────────────────

let pollTimer = null;
let sseCleanup = null;

async function loadAllData() {
  try {
    await refreshWorkspaces();
    await Promise.all([refreshMessages(), refreshTasks(), refreshIssues(), refreshAgentFeedback(), refreshProposals(), refreshCompletionClaims(), refreshAIStatus(), refreshAnnouncements(), refreshShifts(), refreshHandovers()]);
    connectionStatus = 'online';
  } catch (err) {
    connectionStatus = 'offline';
    console.error('Failed to load data:', err);
  }
}

async function refreshWorkspaces() {
  const res = await api.getWorkspaces();
  // Normalize: ensure each workspace has members and rules arrays.
  data.workspaces = (res.workspaces || []).map((w) => ({
    ...w,
    members: Array.isArray(w.members) ? w.members : [],
    rules: Array.isArray(w.rules) ? w.rules : [],
  }));
  if (res.revision) serverRevision = res.revision;
  // Ensure currentWorkspace is valid.
  if (!data.workspaces.some((w) => w.id === currentWorkspace)) {
    currentWorkspace = data.workspaces[0]?.id || 'daily';
  }
}

async function refreshMessages() {
  const res = await api.getMessages(currentWorkspace);
  data.messages = res.messages || data.messages;
  if (res.revision) serverRevision = res.revision;
}

async function refreshTasks() {
  const res = await api.getTasks(currentWorkspace);
  data.tasks = res.tasks || data.tasks;
  if (res.revision) serverRevision = res.revision;
}

async function refreshIssues() {
  const res = await api.getIssues(currentWorkspace);
  data.issues = res.issues || data.issues;
  if (res.revision) serverRevision = res.revision;
}

async function refreshAgentFeedback() {
  if (!admin()) { data.agentFeedback = []; return; }
  try {
    const result = await api.getAgentFeedback(currentWorkspace, identity.userId);
    data.agentFeedback = result.feedback || [];
  } catch (err) {
    console.error('Could not load AI feedback:', err);
  }
}

async function refreshProposals() {
  try {
    const res = await api.getProposals(currentWorkspace);
    data.proposals = res.proposals || [];
    if (res.revision) serverRevision = res.revision;
  } catch { /* proposals endpoint may not exist yet */ }
}

async function refreshCompletionClaims() {
  try {
    const res = await api.getCompletionClaims(currentWorkspace);
    data.completionClaims = res.claims || [];
    if (res.revision) serverRevision = res.revision;
  } catch { /* completion claims endpoint may not exist yet */ }
}

async function refreshAIStatus() {
  try {
    const res = await api.getAIStatus(currentWorkspace);
    data.aiStatus = res;
  } catch { /* ai-status endpoint may not exist yet */ }
}

async function refreshAnnouncements() {
  try {
    const res = await api.getAnnouncements(currentWorkspace);
    data.announcements = res.announcements || [];
  } catch { /* announcements endpoint may not exist yet */ }
}

async function refreshShifts() {
  try {
    const res = await api.getShift(currentWorkspace);
    data.shifts[currentWorkspace] = res;
  } catch { /* ignore */ }
}

async function refreshHandovers() {
  try {
    const res = await api.getHandover(currentWorkspace);
    data.handovers[currentWorkspace] = res;
  } catch { /* ignore */ }
}

async function refreshWorkspaceData() {
  // Called when switching workspaces — refresh all data for the new workspace.
  await Promise.all([refreshMessages(), refreshTasks(), refreshIssues(), refreshAgentFeedback(), refreshProposals(), refreshCompletionClaims(), refreshAIStatus(), refreshAnnouncements(), refreshShifts(), refreshHandovers()]);
  // Reconnect SSE to the new workspace.
  if (sseCleanup) { sseCleanup(); sseCleanup = null; }
  connectSSE();
  render();
}

/** Full sync: check revision, and if changed, refresh all data for current workspace. */
async function fullSync() {
  try {
    const syncRes = await api.sync(currentWorkspace, serverRevision);
    if (syncRes.changed) {
      await Promise.all([refreshMessages(), refreshTasks(), refreshIssues(), refreshAgentFeedback(), refreshProposals(), refreshCompletionClaims(), refreshAIStatus(), refreshAnnouncements(), refreshShifts(), refreshHandovers()]);
      // Also refresh workspaces in case a new one was created.
      await refreshWorkspaces();
      render();
    }
    connectionStatus = 'online';
  } catch (err) {
    connectionStatus = 'offline';
    console.error('Sync failed:', err);
  }
}

/** Connect SSE for real-time push updates. */
function connectSSE() {
  if (sseCleanup) sseCleanup();
  sseCleanup = api.openEvents(currentWorkspace, async (payload) => {
    if (payload.type === 'reset') {
      await loadAllData();
      render();
      return;
    }
    // On any update event, do a full sync to get the latest data.
    await fullSync();
  });
}

/** Start the polling loop (2-second interval) and SSE connection. */
function startSync() {
  connectSSE();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(fullSync, 2000);
}

function stopSync() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (sseCleanup) { sseCleanup(); sseCleanup = null; }
}

// ── Boot sequence ──────────────────────────────────────────────────

async function boot() {
  identity = getIdentity();

  if (!identity) {
    // Show identity selector immediately.
    render();
    return;
  }

  // Identity exists — show loading screen while fetching data.
  loading = true;
  render();

  try {
    await loadAllData();
  } catch (err) {
    console.error('Boot data load failed:', err);
  }
  loading = false;

  if (!location.hash) location.replace(location.href.split('#')[0] + '#/chat');
  render();
  startSync();
}

// Start the app.
boot();
