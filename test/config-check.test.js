'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkConfig, statusOf } = require('../src/services/configCheck');
const FULL = { ADMIN_PASSWORD:'pw-private', WHATSAPP_APP_SECRET:'app-private', WHATSAPP_ACCESS_TOKEN:'token-private', WHATSAPP_PHONE_NUMBER_ID:'123456789', WHATSAPP_VERIFY_TOKEN:'verify-private', WHATSAPP_TEMPLATE_NAME:'exam_invitation', AI_API_KEY:'ai-private', CORS_ORIGIN:'https://admin.school.org' };
const cfg = { appUrl:'https://exam.school.org', admin:{isGenerated:false} };
const find = (r,k) => r.items.find(i=>i.key===k);
test('classifies absent and placeholder values',()=>{
 for(const v of [null,undefined,'',' ']) assert.equal(statusOf(v),'missing');
 for(const v of ['your_key','CHANGEME','replace_me','https://example.com','choose_a_strong_password','any_random_secret_string_you_choose']) assert.equal(statusOf(v),'placeholder');
 assert.equal(statusOf('real-value'),'set');
});
test('fully configured settings produce unique nonwarning entries',()=>{
 const r=checkConfig(cfg,FULL); assert.equal(r.ok,true); assert.equal(r.counts.warning,0);
 assert.equal(new Set(r.items.map(i=>i.key)).size,r.items.length);
});
for(const key of Object.keys(FULL).slice(0,6)) test(key+' missing or placeholder is critical',()=>{
 for(const value of ['', 'your_placeholder']) {
 const r=checkConfig({...cfg,whatsapp:{templateName:'your_placeholder'}},{...FULL,[key]:value});
 assert.equal(r.ok,false); assert.equal(find(r,key).level,'critical');
 assert.equal(r.items.filter(i=>i.key===key).length,1);
 }
});
test('generated admin password remains critical',()=>{
 assert.equal(find(checkConfig({...cfg,admin:{isGenerated:true}},FULL),'ADMIN_PASSWORD').level,'critical');
});
test('unsafe public URLs warn once without exposing values',()=>{
 for(const appUrl of ['http://localhost:3000','https://127.0.0.1','http://[::1]','bad-url','ftp://school.org','https://user:secret@school.org','https://example.com']) {
 const r=checkConfig({...cfg,appUrl},FULL); assert.equal(find(r,'APP_URL').level,'warning',appUrl);
 assert.equal(r.items.filter(i=>i.key==='APP_URL').length,1);
 }
});
test('AI absence warns without preventing manual exam delivery',()=>{
 const r=checkConfig(cfg,{...FULL,AI_API_KEY:''}); assert.equal(r.ok,true); assert.equal(find(r,'AI_API_KEY').level,'warning');
});
test('reports never contain supplied values and counts agree',()=>{
 for(const r of [checkConfig(cfg,FULL),checkConfig({}, {})]) {
 for(const value of Object.values(FULL)) assert.ok(!JSON.stringify(r).includes(value));
 const counts={critical:0,warning:0,info:0}; for(const item of r.items) counts[item.level]++;
 assert.deepEqual(r.counts,counts); assert.equal(r.ok,counts.critical===0);
 }
});

test('CLI and authenticated API use redacted reports with isolated dummy settings', async () => {
 const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path'); const {spawnSync}=require('node:child_process');
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'exam-config-check-'));
 const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,...FULL,APP_URL:cfg.appUrl,DB_PATH:path.join(cwd,'test.db'),SEED_ON_BOOT:'false'};
 try {
  for(const good of [true,false]) {
   const result=spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/config-check.js')],{cwd,env:{...env,...(good?{}:{WHATSAPP_APP_SECRET:''})},encoding:'utf8',timeout:60000});
   assert.equal(result.status,good?0:1,result.stderr || String(result.error));
   assert.match(result.stdout,/not verified/);
   for(const value of Object.values(FULL)) assert.ok(!result.stdout.includes(value));
  }
  const serverPath=path.resolve(__dirname,'../src/server'); const authPath=path.resolve(__dirname,'../src/auth');
  const script=`const assert=require('node:assert/strict'); const app=require(${JSON.stringify(serverPath)}); const auth=require(${JSON.stringify(authPath)}); const server=app.listen(0,'127.0.0.1',async()=>{try { const url='http://127.0.0.1:'+server.address().port+'/api/config-check'; const denied=await fetch(url); assert.equal(denied.status,401); const allowed=await fetch(url,{headers:{Authorization:'Bearer '+auth.adminToken()}}); assert.equal(allowed.status,200); assert.equal(allowed.headers.get('cache-control'),'no-store'); const report=await allowed.json(); assert.equal(report.ok,true); assert.ok(report.items.some(i=>i.key==='WHATSAPP_APP_SECRET')); for(const value of ${JSON.stringify(Object.values(FULL))}) assert.ok(!JSON.stringify(report).includes(value)); }catch(e){console.error(e); process.exitCode=1;} finally { server.closeAllConnections&&server.closeAllConnections(); server.close(); }});`;
  const result=spawnSync(process.execPath,['-e',script],{cwd,env,encoding:'utf8',timeout:60000});
  assert.equal(result.status,0,result.stderr || String(result.error));
 } finally { fs.rmSync(cwd,{recursive:true,force:true}); }
});
