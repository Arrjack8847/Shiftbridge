// Quick integration test: verify the chat-completion API endpoint works
import { getDB, initSchema } from './db.js';
import { seedDatabase } from './seed.js';

// Reset to ensure clean state with new schema
initSchema();
const d = getDB();
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

// Add a test task assigned to Sarah (inventory, self-report, doing status)
const ts = Date.now();
d.prepare(
  `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
   VALUES (?, ?, ?, '', ?, ?, 'normal', ?, '3 PM', NULL, 'test', ?, '', ?, ?)`,
).run('t_lids', 'daily', 'Count takeaway lids', 'sarah', 'doing', 'inventory', 'self-report', ts, ts);

// Add Sarah's completion message
const maxSeq = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get('daily');
const seq = (maxSeq?.maxSeq || 0) + 1;
d.prepare('INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)').run(
  'm_lids_done', 'daily', 'sarah', "I've counted them. We have 120 lids remaining.", Date.now(), seq,
);

// Verify the data is in place
const task = d.prepare('SELECT * FROM tasks WHERE id = ?').get('t_lids');
const msg = d.prepare('SELECT * FROM messages WHERE id = ?').get('m_lids_done');
console.log('Task:', task.id, task.name, task.status, task.assignee, task.category, task.verification);
console.log('Message:', msg.id, msg.user_id, msg.body);
console.log('Both exist:', !!task && !!msg);

// Test the protected task: create a repairs task and test it goes to review
d.prepare(
  `INSERT OR IGNORE INTO tasks (id, workspace_id, name, description, assignee, status, priority, category, due, source, created_by, verification, completion, created_at, updated_at)
   VALUES (?, ?, ?, '', ?, ?, 'high', ?, 'Today', NULL, 'test', ?, '', ?, ?)`,
).run('t_repair', 'daily', 'Fix machine 2 leak', 'jack', 'doing', 'repairs', 'qualified', ts, ts);

const repairMaxSeq = d.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE workspace_id = ?').get('daily');
const repairSeq = (repairMaxSeq?.maxSeq || 0) + 1;
d.prepare('INSERT OR IGNORE INTO messages (id, workspace_id, user_id, body, created_at, seq) VALUES (?, ?, ?, ?, ?, ?)').run(
  'm_repair_done', 'daily', 'jack', "I fixed the leak on machine 2. It's working now.", Date.now(), repairSeq,
);

console.log('\nReady for API testing. Use curl to test:');
console.log('curl -s -X POST http://127.0.0.1:3000/api/workspaces/daily/chat-completion \\');
console.log('  -H "Content-Type: application/json" \\');
console.log('  -d \'{"taskId":"t_lids","messageId":"m_lids_done","reportingEmployee":"sarah"}\'');
