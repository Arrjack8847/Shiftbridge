/**
 * Groq Agent V2 integration: all model calls go to a LOCAL mock HTTP server.
 * No real API key, CodeBuddy, remote model, or production database is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const getPort = () => new Promise((resolve,reject)=>{
  const s=createTcpServer();
  s.once('error',reject);
  s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});
});

test('Groq default processes manager tasks and contextual incident updates without CodeBuddy', {timeout:45000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),'shiftbridge-groq-'));
  const [port,mockPort]=await Promise.all([getPort(),getPort()]);
  const url='http://127.0.0.1:'+port;
  const replies=[];
  const requests=[];
  const mock=createHttpServer(async(req,res)=>{
    try {
      let raw='';
      for await(const chunk of req) raw+=String(chunk);
      const request=JSON.parse(raw);
      requests.push(request);
      const next=replies.shift();
      if(!next){res.writeHead(500);res.end(JSON.stringify({error:'Unexpected model request'}));return;}
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        model:request.model,
        usage:{total_tokens:200},
        choices:[{message:{content:JSON.stringify(next)}}],
      }));
    }catch(err){res.writeHead(500);res.end(JSON.stringify({error:err.message}));}
  });
  await new Promise(resolve=>mock.listen(mockPort,'127.0.0.1',resolve));
  const env={
    ...process.env,
    PORT:String(port),AI_PROVIDER:'groq',
    GROQ_API_URL:'http://127.0.0.1:'+mockPort+'/openai/v1/chat/completions',
    GROQ_API_KEY:'local-test-key',
    GROQ_ENABLED:'1',GROQ_TIMEOUT_MS:'6000',
    SHIFTBRIDGE_API:url+'/api',
    SHIFTBRIDGE_DB_PATH:join(dir,'isolated.db'),
  };
  const child=spawn(process.execPath,['server/index.js'],{
    cwd:process.cwd(),env,windowsHide:true,stdio:['ignore','pipe','pipe'],
  });
  let errors='';
  child.stderr.on('data',v=>errors+=String(v).slice(0,1500));
  let idx=0;
  async function api(method,path,body){
    const r=await fetch(url+path,{
      method,headers:{'Content-Type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(3500),
    });
    return {status:r.status,body:await r.json()};
  }
  async function send(user,body){
    const id='groq_test_'+(++idx);
    const result=await api('POST','/api/workspaces/daily/messages',{id,user,body});
    assert.equal(result.status,201,JSON.stringify(result.body));
    return id;
  }
  async function awaitJob(id){
    for(let n=0;n<120;n++){
      const state=await api('GET','/api/workspaces/daily/groq-status');
      const entry=state.body.recentJobs?.find(x=>x.messageId===id);
      if(entry && ['completed','failed'].includes(entry.status)) {
        assert.equal(entry.status,'completed','Groq job failed: '+entry.error);
        return entry;
      }
      await delay(85);
    }
    throw Error('Timed out waiting for Groq job '+id+' '+errors.slice(-400));
  }

  try {
    let ready=false;
    for(let t=0;t<110;t++){
      if(child.exitCode!==null)break;
      try{if((await api('GET','/api/health')).status===200){ready=true;break;}}catch{}
      await delay(90);
    }
    assert.ok(ready,'Backend unavailable: '+errors.slice(-400));

    replies.push({actions:[{
      type:'create_task',name:'Count missing snack shelf items',
      assignee:'emma',category:'inventory',priority:'normal',due:'Before closing',
      description:'Count and record snack shelf shortages',reasoning:'Manager assigned routine stock work',
    }],analysis:'Manager assigned inventory check'});
    const managerMsg=await send('manager','Emma, could you check the snack shelf and count missing items before closing?');
    await awaitJob(managerMsg);
    const tasks=(await api('GET','/api/workspaces/daily/tasks')).body.tasks;
    assert.ok(tasks.some(t=>t.source===managerMsg && t.assignee==='emma' && t.status==='todo'),'Groq manager task was not persisted');

    replies.push({actions:[{
      type:'report_issue',title:'Printer seems to malfunction',issueType:'equipment',
      reasoning:'Employee reports a grinding noise from printer',
    }],analysis:'Possible operational printer issue'});
    const first=await send('emma','The printer sounds awful and keeps making a grinding noise.');
    await awaitJob(first);
    const issues=(await api('GET','/api/workspaces/daily/issues')).body.issues;
    const incident=issues.find(i=>i.source===first);
    assert.ok(incident,'Groq issue was not persisted');
    assert.ok(incident.linkedMessages.some(m=>m.id===first));

    replies.push({actions:[{
      type:'link_issue',issueId:incident.id,relation:'update',
      reasoning:'Follow-up noise refers to the printer reported immediately before',
    }],analysis:'Linked the follow-up to printer issue'});
    const follow=await send('emma',"It's still making the same grinding noise.");
    await awaitJob(follow);
    const latest=(await api('GET','/api/issues/'+incident.id)).body;
    assert.ok(latest.linkedMessages.some(m=>m.id===follow),'Groq did not link follow-up to existing issue');
    assert.equal((await api('GET','/api/workspaces/daily/issues')).body.issues.filter(i=>i.id===incident.id).length,1);

    // The model cannot relabel a protected repair as a routine task.
    replies.push({actions:[{
      type:'create_task',name:'Repair the broken printer',assignee:'emma',
      category:'routine',priority:'high',description:'Repair the malfunctioning printer',
      reasoning:'Manager requested repair',
    }],analysis:'Protected repair requires review'});
    const protectedMsg=await send('manager','Emma, please repair the broken printer before closing.');
    await awaitJob(protectedMsg);
    const repairTask=(await api('GET','/api/workspaces/daily/tasks')).body.tasks
      .find(t=>t.source===protectedMsg);
    assert.ok(!repairTask,'Groq must not silently create protected repair tasks');
    const proposals=(await api('GET','/api/workspaces/daily/proposals')).body.proposals;
    assert.ok(proposals.some(p=>p.sourceMessageId===protectedMsg),
      'Protected manager request should create a proposal for review');

    // An employee cannot turn a model-generated create_task into a direct assignment.
    replies.push({actions:[{
      type:'create_task',name:'Count new snack shelf items',
      assignee:'sarah',category:'inventory',priority:'normal',
      reasoning:'Employee suggested stock work',
    }],analysis:'Employee cannot directly assign tasks'});
    const employeeMsg=await send('emma','Sarah, could you count the snack shelf items tomorrow?');
    await awaitJob(employeeMsg);
    const after=(await api('GET','/api/workspaces/daily/tasks')).body.tasks;
    assert.ok(!after.some(t=>t.source===employeeMsg),'Employee message cannot silently create task');
    const afterProps=(await api('GET','/api/workspaces/daily/proposals')).body.proposals;
    assert.ok(afterProps.some(p=>p.sourceMessageId===employeeMsg),
      'Employee suggestion should require manager review');

    // Fast path must bypass the LLM for certain claims.
    const callCount=requests.length;
    await send('emma','The printer is broken.');
    await delay(100);
    assert.equal(requests.length,callCount,'Fast warning should not pay for a new Groq model call');
    assert.equal(requests.length,5,'Unexpected Groq calls');
    assert.equal(requests[0].response_format.type,'json_object');
    assert.ok(requests[2].messages[1].content.includes(incident.id),'Model was not given Agent V2 incident memory');
  } finally {
    child.kill();
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(1800)]);
    await new Promise(resolve=>mock.close(resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});
