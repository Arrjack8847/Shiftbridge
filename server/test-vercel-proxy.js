import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import proxy from '../api/proxy.js';

const oldURL=process.env.SHIFTBRIDGE_RENDER_URL;
const originalFetch=globalThis.fetch;
after(()=>{
  if(oldURL===undefined)delete process.env.SHIFTBRIDGE_RENDER_URL;
  else process.env.SHIFTBRIDGE_RENDER_URL=oldURL;
  globalThis.fetch=originalFetch;
});
const req=(path,options)=>new Request('https://shiftbr.vercel.app/api/proxy?__sb_route='+encodeURIComponent(path)+(options?.query||''),options);

test('missing Render origin returns explicit 503 instead of Vercel 404',async()=>{
 delete process.env.SHIFTBRIDGE_RENDER_URL;
 const res=await proxy.fetch(req('sync'));
 assert.equal(res.status,503);
 assert.equal((await res.json()).code,'BACKEND_NOT_CONFIGURED');
});

test('GET retains original route and query string',async()=>{
 process.env.SHIFTBRIDGE_RENDER_URL='https://example.onrender.com';
 let forwarded;
 globalThis.fetch=async(url,options)=>{
  forwarded={url:String(url),options};
  return new Response(JSON.stringify({changed:false,revision:3}),{status:200,headers:{'content-type':'application/json'}});
 };
 const res=await proxy.fetch(req('sync',{query:'&workspace=daily&revision=0'}));
 assert.equal(res.status,200);
 assert.equal(forwarded.url,'https://example.onrender.com/api/sync?workspace=daily&revision=0');
 assert.equal(forwarded.options.method,'GET');
 assert.equal((await res.json()).revision,3);
});

test('POST preserves chat JSON request',async()=>{
 process.env.SHIFTBRIDGE_RENDER_URL='https://example.onrender.com';
 let captured;
 globalThis.fetch=async(url,options)=>{
  captured={url:String(url),body:new TextDecoder().decode(options.body)};
  return new Response(JSON.stringify({id:'m8'}),{status:201,headers:{'content-type':'application/json'}});
 };
 const res=await proxy.fetch(req('workspaces/daily/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'m8',user:'jack',body:'Hello'})}));
 assert.equal(captured.url,'https://example.onrender.com/api/workspaces/daily/messages');
 assert.deepEqual(JSON.parse(captured.body),{id:'m8',user:'jack',body:'Hello'});
 assert.equal(res.status,201);
});

test('SSE is disabled in proxy; caller uses polling',async()=>{
 process.env.SHIFTBRIDGE_RENDER_URL='https://example.onrender.com';
 const res=await proxy.fetch(req('events',{query:'&workspace=daily'}));
 assert.equal(res.status,204);
});

test('invalid route and self-proxy origin rejected',async()=>{
 process.env.SHIFTBRIDGE_RENDER_URL='https://example.onrender.com';
 assert.equal((await proxy.fetch(req('../secret'))).status,400);
 process.env.SHIFTBRIDGE_RENDER_URL='https://shiftbr.vercel.app';
 assert.equal((await proxy.fetch(req('health'))).status,503);
});

test('upstream connection failures show 502 backend unavailable',async()=>{
 process.env.SHIFTBRIDGE_RENDER_URL='https://example.onrender.com';
 globalThis.fetch=async()=>{throw new Error('connection refused');};
 const res=await proxy.fetch(req('health'));
 assert.equal(res.status,502);
 assert.equal((await res.json()).code,'BACKEND_UNAVAILABLE');
});
