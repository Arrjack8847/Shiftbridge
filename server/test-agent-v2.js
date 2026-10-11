/**
 * Agent V2 isolated API integration tests. No Tencent account required.
 * Starts a child server with a temporary SQLite database and kills it on exit.
 * IMPORTANT: does not touch server/shiftbridge.db or a connected CodeBuddy agent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizeEntityKey } from './incident-memory.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

test('Agent V2: recent messages, incident memory, feedback, isolation and safety', {timeout:30000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shiftbridge-agent-v2-'));
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const env = {
    ...process.env,
    PORT:String(port),
    SHIFTBRIDGE_DB_PATH:join(dir,'isolated.db'),
    AI_PROVIDER:'tencent-local',
    CODEBUDDY_EXECUTION_MODE:'serve',
    CODEBUDDY_SERVE_URL:'http://127.0.0.1:9',
  };
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),env,stdio:['ignore','pipe','pipe'],windowsHide:true,
  });
  let logs = '';
  child.stdout.on('data', b => { logs += String(b).slice(0, 1500); });
  child.stderr.on('data', b => { logs += String(b).slice(0, 1500); });

  async function api(method,path,body) {
    const resp = await fetch(origin + path, {
      method,headers:{'Content-Type':'application/json'},
      ...(body===undefined ? {} : {body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(3500),
    });
    const result = await resp.json();
    return {status:resp.status, body:result};
  }

  let counter = 0;
  async function send(body, user='emma', ws='daily') {
    const id = 'v2msg'+(++counter);
    const result = await api('POST','/api/workspaces/'+ws+'/messages',{id,user,body});
    assert.equal(result.status,201,JSON.stringify(result.body));
    return id;
  }

  try {
    let ready = false;
    for (let i=0;i<80;i++) {
      if (child.exitCode !== null) break;
      try { if ((await api('GET','/api/health')).status===200) {ready=true;break;} } catch {}
      await delay(100);
    }
    assert.ok(ready,'Server could not start: '+logs.slice(-600));
    assert.equal(normalizeEntityKey('Machine 2 is leaking'), 'machine-2');
    assert.equal(normalizeEntityKey('There is water underneath it'), null);

    for (let i=0;i<24;i++) await send('hi');
    const recent = await api('GET','/api/workspaces/daily/messages?limit=3&latest=1');
    assert.equal(recent.status,200);
    assert.deepEqual(recent.body.messages.map(x=>x.id),['v2msg22','v2msg23','v2msg24']);

    const first = await send('Machine 2 is leaking');
    const second = await send('Machine 2 is broken again');
    const list = await api('GET','/api/workspaces/daily/issues');
    const issues = list.body.issues.filter(i=>i.entityKey==='machine-2' && i.status!=='resolved');
    assert.equal(issues.length,1,'Repeated equipment warning should not create duplicate active issues');
    const issue = issues[0];
    assert.ok(issue.linkedMessages.some(m=>m.id===first));
    assert.ok(issue.linkedMessages.some(m=>m.id===second));

    const followUp = await send('There is water under it again');
    const linkUrl = '/api/workspaces/daily/incidents/'+issue.id+'/link-message';
    const linked = await api('POST',linkUrl,{
      messageId:followUp,relation:'update',
      reason:'Context refers to the previously reported Machine 2 leak',
    });
    assert.equal(linked.status,201,JSON.stringify(linked.body));
    assert.equal((await api('POST',linkUrl,{
      messageId:followUp,relation:'update',
      reason:'Context refers to the previously reported Machine 2 leak',
    })).status,200,'Link should be idempotent');

    assert.equal((await api('POST',
      '/api/workspaces/riverside/incidents/'+issue.id+'/link-message',
      {messageId:followUp,relation:'update',reason:'Cross workspace link should never succeed'})).status,404);

    const smoke = await send('Machine 2 is sparking');
    const latest = await api('GET','/api/issues/'+issue.id);
    assert.equal(latest.status,200);
    assert.equal(latest.body.severity,'high','Safety warning should escalate existing incident');
    assert.equal(latest.body.requiresApproval,true);
    assert.ok(latest.body.linkedMessages.some(m=>m.id===smoke));

    const noDirectResolve = await api('PUT','/api/issues/'+issue.id,{status:'resolved',actor:'emma'});
    assert.equal(noDirectResolve.status,403);

    const denied = await api('POST','/api/workspaces/daily/agent-feedback',{
      issueId:issue.id,messageId:first,reviewerId:'emma',verdict:'correct_issue',
    });
    assert.equal(denied.status,403);
    const reviewed = await api('POST','/api/workspaces/daily/agent-feedback',{
      issueId:issue.id,messageId:first,reviewerId:'manager',verdict:'correct_issue',
      note:'Reviewed source incident report',
    });
    assert.equal(reviewed.status,201,JSON.stringify(reviewed.body));
    const feedback = await api('GET','/api/workspaces/daily/agent-feedback?reviewerId=manager');
    assert.ok(feedback.body.feedback.some(f=>f.issueId===issue.id && f.verdict==='correct_issue'));

    const context = await api('GET','/api/workspaces/daily/incident-context');
    assert.ok(context.body.incidents.some(i=>i.id===issue.id && i.messages.length>0));
    assert.ok(context.body.feedbackExamples.some(example =>
      example.messageId===first && example.verdict==='correct_issue'),
      'Manager labels should be available to future Tencent context prompts');
    const otherContext = await api('GET','/api/workspaces/riverside/incident-context');
    assert.ok(!otherContext.body.incidents.some(i=>i.id===issue.id));
  } finally {
    child.kill();
    await Promise.race([
      new Promise(resolve => child.once('exit',resolve)),
      delay(1500),
    ]);
    rmSync(dir,{recursive:true,force:true});
  }
});
