'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const source = fs.readFileSync(process.env.QP_TS_SRC || path.join(__dirname, '..', 'dist', 'test-bundle.js'), 'utf8');
function harness(pre) {
  let time = 1000;
  const saved = new Map();
  if (pre) for (const k of Object.keys(pre)) saved.set(k, pre[k]);
  const intervals = [];
  const ctx = {
    console: {log:console.log, warn(){}, error:console.error}, TextDecoder, TextEncoder, URL, URLSearchParams, Request, Response,
    location: { pathname: '/chat/chat-alpha' },
    performance: { now: () => time }, Date,
    localStorage: {getItem: k => saved.get(k) || null, setItem: (k,v) => saved.set(k,String(v))},
    sessionStorage: {getItem: () => null},
    document: {readyState: 'complete', querySelector: () => null, querySelectorAll: () => [], getElementById: () => null},
    addEventListener() {},
    setInterval: fn => {intervals.push(fn); return intervals.length;}, clearInterval() {},
    setTimeout, clearTimeout,
    fetch: () => Promise.resolve(new Response('{}', {headers:{'content-type':'application/json'}})),
  };
  ctx.window = ctx;
  // v2：测试 bundle 已置空渲染总线并暴露 window.testApi，直接 eval（不再 marker 注入）
  vm.runInNewContext(source, ctx);
  return {ctx, a: ctx.testApi, saved, advance: ms => {time += ms;}, at: () => time};
}
function start(h, sid='chat-alpha', epoch=1) {const s=h.a.getState(sid);h.a.startTurn(h.at(),s,epoch);return s;}
function event(h,s,obj,ms=100) {h.advance(ms);h.a.handleEvent(JSON.stringify(obj),s);}
function text(h,s,value,ms=100) {event(h,s,{type:'text',delta:true,msg_id:'m1',index:0,text:value},ms);}
function done(h,s,usage) {if(usage) event(h,s,{type:'turn_usage',usage},100);h.a.endTurn('done',s,'','stream_end');return s.lastResult;}
function usage(ct,pt=100) {return {prompt_tokens:pt,completion_tokens:ct,total_tokens:pt+ct,provider_id:'unknown'};}
function deferred() {let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const settle = async () => {for(let i=0;i<12;i++) await new Promise(r=>setImmediate(r));};
const tests = [];
function test(name,fn) {tests.push([name,fn]);}

test('真实流末 delta:false 快照不能重复累计之前的增量', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  event(h,s,{type:'text',delta:false,msg_id:'m1',index:0,text:'一'.repeat(20)+'二'.repeat(20)});
  assert.equal(s.tokenCount,40);assert.equal(s.charCount,40);
});
test('真实 reasoning completed 消息外壳不能再次计入已流式到达的内容', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  event(h,s,{type:'reasoning',object:'message',id:'m1',role:'assistant',status:'completed',content:[{type:'text',delta:false,index:null,msg_id:null,text:'一'.repeat(20)+'二'.repeat(20)}]});
  assert.equal(s.tokenCount,40);
});
test('后端精确 turn_usage 不被之后的单消息用量降级', () => {
  const h=harness(),s=start(h);event(h,s,{type:'turn_usage',usage:usage(300)});
  event(h,s,{type:'message',usage:{input_tokens:100,output_tokens:50}});
  assert.equal(s.finalUsage.generated,300);assert.equal(s.finalUsage.exact,true);
});
test('发送新请求时使用明确的新生成模式，大首包不能被当回放', () => {
  const h=harness(),s=h.a.getState('chat-alpha');h.a.startTurn(h.at(),s,1,{fresh:true});
  text(h,s,'一'.repeat(700));assert.equal(s.attached,false);assert.equal(s.tokenCount,700);
});
test('reconnect 请求从首包就按显式回放处理，直到 replay_end', () => {
  const h=harness(),s=h.a.getState('chat-alpha');h.a.startTurn(h.at(),s,1,{reconnect:true});
  for(let i=0;i<10;i++)text(h,s,'一'.repeat(20),1000);
  assert.equal(s.attached,true);assert.equal(s.replayDone,false);assert.equal(s.tokenCount,0);assert.equal(s.replayTokens,200);
  if(h.a.maintain)h.a.maintain(s,h.at()+5000);assert.equal(s.pauseMs,0);
  event(h,s,{type:'replay_end'});text(h,s,'二'.repeat(20));text(h,s,'三'.repeat(20));
  const r=done(h,s,usage(120));assert.equal(r.pauseSec,0);
  assert.ok(Math.abs(r.tokens+r.replayTokens+r.toolTokens-r.outputTokens)<1e-8);
  assert.ok(r.replayTokens<=r.outputTokens);
});
test('显式回放中的工具参数保留在整轮输出量中', () => {
  const h=harness(),s=h.a.getState('chat-alpha');h.a.startTurn(h.at(),s,1,{reconnect:true});
  event(h,s,{type:'plugin_call',id:'c1'});
  event(h,s,{type:'data',delta:true,data:{call_id:'c1',arguments:'x'.repeat(80)}});
  event(h,s,{type:'plugin_call_output',id:'c1'},5000);
  event(h,s,{type:'replay_end'});text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  assert.equal(s.toolTokens,20);assert.equal(s.pauseMs,0);
  const r=done(h,s,usage(120));assert.ok(Math.abs(r.tokens+r.replayTokens+r.toolTokens-120)<1e-8);
});
test('切到别的会话导致连接断开，不落库为模型已中断', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));h.ctx.location.pathname='/chat/chat-beta';
  h.a.finishAbnormal(s,'signal is aborted without reason','read_error');
  assert.equal(s.active,false);assert.equal(s.suspended,true);assert.equal(h.saved.has('qp_token_speed_by_session'),false);
});
test('同页切换后重连接续原始回合时钟', () => {
  const h=harness(),s=start(h);const origin=s.t0;text(h,s,'一'.repeat(20));h.ctx.location.pathname='/chat/chat-beta';
  h.a.finishAbnormal(s,'aborted','read_error');h.advance(5000);h.ctx.location.pathname='/chat/chat-alpha';
  h.a.startTurn(h.at(),s,2,{reconnect:true});assert.equal(s.t0,origin);assert.equal(s.attached,true);
});
test('后台完成后通过聊天元数据恢复精确用量，速度标为未观测', () => {
  const h=harness();assert.ok(h.a.hydrateHistory);
  const messages=[{role:'user',id:'u1',metadata:{timestamp:'2026-10-18T12:00:00Z'}},
    {role:'assistant',id:'m1',type:'message',status:'completed',metadata:{timestamp:'2026-10-18T12:01:00Z',metadata:{qwenpaw_turn_usage:{usage:usage(300)}}}}];
  h.a.hydrateHistory('chat-alpha',{messages,status:'completed'});
  const r=JSON.parse(h.saved.get('qp_token_speed_by_session'))['chat-alpha'];
  assert.equal(r.outputTokens,300);assert.equal(r.historyOnly,true);assert.equal(r.genSpeed,0);assert.equal(r.seconds,60);
});
test('新用户回合尚未完成，不能把上一轮历史用量当新结果', () => {
  const h=harness();assert.ok(h.a.hydrateHistory);
  h.a.hydrateHistory('chat-alpha',{status:'running',messages:[{role:'assistant',id:'old',metadata:{metadata:{qwenpaw_turn_usage:{usage:usage(300)}}}},{role:'user',id:'new'}]});
  assert.equal(h.saved.has('qp_token_speed_by_session'),false);
});
test('历史接口每次生成新的消息 ID，仍保留本轮实测速度', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));const r=done(h,s,usage(50));
  const end=new Date(r.ts).toISOString();
  h.a.hydrateHistory('chat-alpha',{status:'idle',messages:[{role:'user',metadata:{}},
   {id:'regenerated-id',role:'assistant',type:'message',metadata:{timestamp:end,original_id:'stable-backend-id',metadata:{qwenpaw_turn_usage:{usage:usage(50)}}}}]});
  const saved=JSON.parse(h.saved.get('qp_token_speed_by_session'))['chat-alpha'];
  assert.equal(saved.genSpeed,r.genSpeed);assert.notEqual(saved.historyOnly,true);
});
test('同一网络包里的多条 delta 共用时间戳，不能放大包间速度', async () => {
  const h=harness(),s=h.a.getState('chat-alpha');
  const packet=Array.from({length:5},()=> 'data: '+JSON.stringify({type:'text',delta:true,msg_id:'m1',text:'一'.repeat(20)})+'\n\n').join('');
  let i=0;const response={body:{getReader:()=>({read:()=>{if(i++>=2)return Promise.resolve({done:true});h.advance(1000);return Promise.resolve({done:false,value:new TextEncoder().encode(packet)});}})}};
  h.a.monitorStream(response,h.at(),s,1);await settle();
  assert.equal(s.lastResult.tokens,200);assert.equal(s.lastResult.genSpeed,100);assert.equal(s.lastResult.peak,100);
});
test('历史供应商未知时，不能按当前切换到的另一供应商重算金额', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  const r=done(h,s,{...usage(50),provider_id:'unrecognized-vendor',model_name:'deepseek-v4-flash'});
  assert.equal(r.channel,'other');
  h.a.setChannelConfig({providerId:'deepseek',model:'deepseek-v4-flash',ts:Date.now()});
  h.a.applyBillingRetro(true);
  const saved=JSON.parse(h.saved.get('qp_token_speed_by_session'))['chat-alpha'];
  assert.equal(saved.channel,'other');assert.equal(saved.cost,null);assert.equal(saved.provider,'unrecognized-vendor');
});
test('真实工具输出用新消息 ID：按 data.call_id 关联，进行中事件不能提早结束', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));
  event(h,s,{type:'plugin_call',object:'message',status:'in_progress',id:'request-message',content:[]});const begin=h.at();
  event(h,s,{type:'data',delta:true,msg_id:'request-message',data:{call_id:'real-call',name:'execute_shell_command',arguments:''}});
  event(h,s,{type:'data',delta:true,msg_id:'request-message',data:{arguments:'x'.repeat(40)}});
  event(h,s,{type:'plugin_call',object:'message',status:'completed',id:'request-message',content:[]});
  event(h,s,{type:'plugin_call_output',object:'message',status:'in_progress',id:'output-message',content:[]});
  event(h,s,{type:'data',delta:true,msg_id:'output-message',status:'in_progress',data:{call_id:'real-call',output:''}});
  assert.equal(s.toolPending,true);
  event(h,s,{type:'data',delta:false,msg_id:'output-message',status:'completed',data:{call_id:'real-call',output:'4',state:'completed'}},3000);
  const finished=h.at();assert.equal(s.toolPending,false);assert.equal(s.pauseMs,finished-begin);
  event(h,s,{type:'plugin_call_output',object:'message',status:'completed',id:'output-message',content:[]});
  text(h,s,'二'.repeat(20),4000);
  assert.equal(s.pauseMs,finished-begin);assert.equal(s.modelWaitMs,h.at()-finished);
});
test('回放结束时尚未结束的工具，只计算接入后的执行等待', () => {
  const h=harness(),s=h.a.getState('chat-alpha');h.a.startTurn(h.at(),s,1,{reconnect:true});
  event(h,s,{type:'plugin_call',id:'request',status:'in_progress'});
  event(h,s,{type:'data',delta:true,msg_id:'request',data:{call_id:'c1',arguments:''}});
  h.advance(5000);event(h,s,{type:'replay_end'});const begin=h.at();
  event(h,s,{type:'data',delta:false,msg_id:'output',status:'completed',data:{call_id:'c1',output:'4'}},3000);
  assert.equal(s.pauseMs,h.at()-begin);assert.equal(s.toolPending,false);
});
test('只有首包或过短的段不能在图上伪造零速度', () => {
  const h=harness();const measurable={tokens:100,firstTokens:20,t0:1000,t1:2000};
  const single={tokens:1,firstTokens:1,t0:2000,t1:2010};
  assert.ok(h.a.segRowHtml(single,1,false).includes('—'));
  assert.ok(!h.a.buildDetailChart([measurable,single]).includes('<svg'));
});
test('完整会话 ID，包括非十六进制字符', () => {
  const h=harness();assert.equal(h.a.getSessionId(),'chat-alpha');
  h.ctx.location.pathname='/chat/1792324347415-test01';assert.equal(h.a.getSessionId(),'1792324347415-test01');
});
test('重复 delta 是真实输出，不能按全文前缀去重', () => {
  const h=harness(),s=start(h);const chunk='一'.repeat(24);
  text(h,s,chunk);text(h,s,chunk);text(h,s,chunk);
  assert.equal(s.charCount,72);assert.equal(s.tokenCount,72);
});
test('思考与正文独立累计快照，不互相去重', () => {
  const h=harness(),s=start(h);const v='一'.repeat(24);
  event(h,s,{type:'reasoning',delta:false,msg_id:'m1',text:v});
  event(h,s,{type:'reasoning',delta:false,msg_id:'m1',text:v+'二'.repeat(4)});
  event(h,s,{type:'text',delta:false,msg_id:'m1',text:v});
  event(h,s,{type:'text',delta:false,msg_id:'m1',text:v});
  assert.equal(s.charCount,52);
});
test('没有后端用量时不把估算再次反馈进校准比例', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  const before=h.a.ratioFor('');done(h,s);assert.equal(h.a.ratioFor(''),before);
});
test('批量冲刷在后续窗口仍保持剔除', () => {
  const h=harness(),s=start(h);event(h,s,{type:'replay_end'});
  for(let i=0;i<8;i++)text(h,s,'一'.repeat(20),150);
  text(h,s,'二'.repeat(1000),1300);assert.equal(s.flushPeak,true);
  text(h,s,'三'.repeat(20),100);assert.ok(s.lastSpeed<200,'speed='+s.lastSpeed);
});
test('连续正常大片不误标为静默后的批量冲刷', () => {
  const h=harness(),s=start(h);event(h,s,{type:'replay_end'});
  text(h,s,'一'.repeat(700));text(h,s,'二'.repeat(700),500);
  assert.equal(s.flushPeak,false);assert.ok(s.lastSpeed>1000);
});
test('稳定分片的生成速度不把首包 Token 重复摊入后续时长', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  const r=done(h,s);assert.equal(r.tokens,40);assert.equal(r.genSpeed,200);
});
test('单包回复不能凭空生成峰值或纯生成速度', () => {
  const h=harness(),s=start(h);event(h,s,{type:'replay_end'});text(h,s,'一'.repeat(700));h.advance(1000);
  const r=done(h,s);assert.equal(r.tokens,700);assert.equal(r.genSpeed,0);assert.equal(r.peak,0);
});
test('工具帧能够取消已经恢复的瞬时 error', () => {
  const h=harness(),s=start(h);
  event(h,s,{type:'error',message:'transient'});
  event(h,s,{type:'data',delta:true,data:{call_id:'c1',arguments:'{"x":1}'}});
  assert.equal(s.pendingError,'');assert.equal(done(h,s).status,'done');
});
test('工具专用输出被中断时归为已中断', () => {
  const h=harness(),s=start(h);
  event(h,s,{type:'data',delta:true,data:{call_id:'c1',arguments:'{"hello":"world"}'}});
  h.a.finishAbnormal(s,'network failed','read_error');assert.equal(s.lastResult.status,'abort');
});
test('无 usage 时输出总量包含工具参数', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  event(h,s,{type:'data',delta:true,data:{call_id:'c1',arguments:'x'.repeat(80)}});
  const r=done(h,s);assert.equal(r.costTokens,60);assert.equal(r.outputTokens,60);
});
test('后端精确用量为零，不能回退正文估算', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));const r=done(h,s,usage(0));
  assert.equal(r.outputTokens,0);assert.equal(r.costTokens,0);
});
test('缓存命中可以从非零更新为零', () => {
  const h=harness(),s=start(h);
  event(h,s,{type:'turn_usage',usage:{...usage(20),cache_read_tokens:80}});
  event(h,s,{type:'turn_usage',usage:{...usage(30),cache_read_tokens:0}});
  assert.equal(s.cacheHitTokens,0);
});
test('拒绝负数及非有限精确用量', () => {
  const h=harness();assert.equal(h.a.extractUsage({usage:usage(-1)}),null);
  assert.equal(h.a.extractUsage({usage:usage(Infinity)}),null);
});
test('权威 turn_usage 不被工具分段的估算比例守卫抛弃', () => {
  const h=harness(),s=start(h);
  for(let i=0;i<4;i++) {
    text(h,s,'一'.repeat(10));
    event(h,s,{type:'plugin_call',id:'c'+i});
    event(h,s,{type:'plugin_call_output',id:'c'+i},300);
  }
  const r=done(h,s,usage(500));assert.equal(r.outputTokens,500);assert.equal(r.tokens+r.toolTokens,500);
});
test('短回放结束信号关闭探测，之后的大增量仍为 live', () => {
  const h=harness(),s=start(h);event(h,s,{type:'replay_end'});
  text(h,s,'一'.repeat(700));assert.equal(s.attached,false);assert.equal(s.tokenCount,700);
});
test('工具起止不应把正文段延长到边界事件', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  const last=h.at();event(h,s,{type:'plugin_call',id:'c1'},800);
  assert.equal(s.segments[0].t1,last);
});
test('工具执行等待只算一次，不和轮询静默重复相加', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  event(h,s,{type:'plugin_call',id:'c1'});
  h.advance(5000);if(h.a.maintain)h.a.maintain(s,h.at());
  event(h,s,{type:'plugin_call_output',id:'c1'},100);
  assert.ok(s.pauseMs<=5100,'pauseMs='+s.pauseMs);
});
test('并发工具等待取时间并集，首个工具结束不能关闭整个等待', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  event(h,s,{type:'plugin_call',id:'c1'});const begin=h.at();
  event(h,s,{type:'plugin_call',id:'c2'});
  event(h,s,{type:'plugin_call_output',id:'c1'},500);
  assert.equal(s.toolPending,true);
  event(h,s,{type:'plugin_call_output',id:'c2'},500);
  assert.equal(s.pauseMs,h.at()-begin);
});
test('开始新段后不复用工具调用前的速度窗口', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  event(h,s,{type:'plugin_call',id:'c1'});event(h,s,{type:'plugin_call_output',id:'c1'},500);
  text(h,s,'三'.repeat(20));assert.equal(s.lastSpeed,0);
});
test('静默补测不篡改最后正文时间或漏掉停顿余量', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  const last=s.tLast;h.advance(2500);if(h.a.maintain)h.a.maintain(s,h.at());
  text(h,s,'三'.repeat(20),500);
  assert.equal(s.segments[0].t1,last);assert.equal(s.pauseMs,3000);
});
test('慢响应头不让旧请求覆盖已完成的新回合', async () => {
  const h=harness();const old=deferred();let n=0;
  h.ctx.fetch=()=>++n===1?old.promise:Promise.resolve(new Response('data: {"type":"text","delta":true,"text":"新回合"}\n\n',{headers:{'content-type':'text/event-stream'}}));
  h.a.patchFetch();const p=h.ctx.fetch('/api/console/chat',{method:'POST'});
  await h.ctx.fetch('/api/console/chat',{method:'POST'});await settle();
  const expected=h.a.states['chat-alpha'].lastResult;
  old.resolve(new Response('data: {"type":"text","text":"旧回合"}\n\n',{headers:{'content-type':'text/event-stream'}}));
  await p;await settle();assert.equal(h.a.states['chat-alpha'].lastResult,expected);
});
test('发出请求即进入等待，并显示网络错误', async () => {
  const h=harness(),d=deferred();h.ctx.fetch=()=>d.promise;h.a.patchFetch();
  const p=h.ctx.fetch('/api/console/chat',{method:'POST'});
  assert.equal(h.a.states['chat-alpha'].active,true);
  d.reject(new Error('offline'));await assert.rejects(p);await settle();
  assert.equal(h.a.states['chat-alpha'].lastResult.status,'error');
});
test('停止只影响 chat_id 指定的会话', async () => {
  const h=harness(),a=start(h,'chat-alpha',1),b=start(h,'chat-beta',2);h.a.patchFetch();
  await h.ctx.fetch('/api/console/chat/stop?chat_id=chat-beta',{method:'POST'});
  assert.equal(a.userStopped,false);assert.equal(b.userStopped,true);
});
test('用户停止后即使流正常 EOF 也应记录已中断', async () => {
  const h=harness();const read=deferred();let i=0;
  h.ctx.fetch=()=>Promise.resolve({ok:true,body:{},headers:{get:()=> 'text/event-stream'},clone:()=>({body:{getReader:()=>({read:()=>++i===1?read.promise:Promise.resolve({done:true})})}})});
  h.a.patchFetch();await h.ctx.fetch('/api/console/chat',{method:'POST'});
  await h.ctx.fetch('/api/console/chat/stop?chat_id=chat-alpha',{method:'POST'});
  read.resolve({done:true});await settle();assert.equal(h.a.states['chat-alpha'].lastResult.status,'abort');
});
test('HTTP 错误不悬挂统计，且返回原响应', async () => {
  const h=harness(),resp=new Response('failure',{status:503});h.ctx.fetch=()=>Promise.resolve(resp);h.a.patchFetch();
  const actual=await h.ctx.fetch('/api/console/chat',{method:'POST'});
  assert.equal(actual,resp);assert.equal(h.a.states['chat-alpha'].lastResult.endCause,'http_error');
});
test('观察器不消费或修改宿主获得的原始响应', async () => {
  const h=harness(),raw='data: {"type":"text","delta":true,"text":"你好"}\n\ndata: [DONE]\n\n';
  const resp=new Response(raw,{headers:{'content-type':'text/event-stream'}});h.ctx.fetch=()=>Promise.resolve(resp);h.a.patchFetch();
  const actual=await h.ctx.fetch('/api/console/chat',{method:'POST'});
  assert.equal(actual,resp);assert.equal(await actual.text(),raw);await settle();
  assert.equal(h.a.states['chat-alpha'].lastResult.tokens,2);
});
test('SSE 多行 data 和任意分块不丢事件', async () => {
  const h=harness(),s=h.a.getState('chat-alpha');
  const data='event: message\r\ndata: {"type":"text",\r\ndata: "delta":true,"text":"你好世界"}\r\n\r\n';
  const bytes=new TextEncoder().encode(data);let i=0;
  const response={body:{getReader:()=>({read:()=>Promise.resolve(i<bytes.length?{done:false,value:bytes.slice(i,i+=3)}:{done:true})})}};
  h.a.monitorStream(response,h.at(),s,1);await settle();
  assert.equal(s.lastResult.tokens,4);
});
test('精确输出正文、工具及分段校准后保持一致', () => {
  const h=harness(),s=start(h);text(h,s,'一'.repeat(20));text(h,s,'二'.repeat(20));
  event(h,s,{type:'plugin_call',id:'c1'});event(h,s,{type:'data',delta:true,data:{call_id:'c1',arguments:'x'.repeat(40)}});
  event(h,s,{type:'plugin_call_output',id:'c1'});text(h,s,'三'.repeat(20));text(h,s,'四'.repeat(20));
  const r=done(h,s,usage(300));
  assert.equal(r.outputTokens,300);assert.equal(r.tokens+r.toolTokens,300);
  assert.ok(Math.abs(r.segments.reduce((n,v)=>n+v.tokens,0)-r.tokens)<1e-8);
});
test('精确用量校准后已有分段行同步更新，保留行元素', () => {
  const h=harness();const rows=[{innerHTML:'stale',className:'qp-d-row qp-d-cur'}];
  const box={children:rows};
  h.a.syncSegs(box,[{tokens:300,firstTokens:100,t0:1000,t1:2000}],false);
  assert.equal(box.children[0],rows[0]);assert.ok(rows[0].innerHTML.includes('300 tok'));
  assert.ok(rows[0].innerHTML.includes('200.0 tok/s'));assert.equal(rows[0].className,'qp-d-row');
});
test('运行时覆盖层：用户条目前置优先命中，内置表不丢', () => {
  const overlay = JSON.stringify({afp: {base: [{keys: ['glm-5.3-flash'], coef: 9.9}]}});
  const h = harness({'qp_token_speed_pricing': overlay});
  const s = start(h); s.model = 'glm-5.3-flash'; text(h, s, '一'.repeat(20)); text(h, s, '二'.repeat(20));
  const r = done(h, s, {prompt_tokens: 100, completion_tokens: 120, total_tokens: 220, provider_id: 'agentplan-x', model: 'glm-5.3-flash'});
  assert.ok(Math.abs(r.afp - (100 + 120) * 9.9 / 10000) < 1e-9);
});
test('泛渠道价表 + 自定义渠道映射：任意渠道配表即算钱', () => {
  const overlay = JSON.stringify({
    customChannels: [{keys: ['my-provider'], channel: 'myapi'}],
    generic: {models: [{channel: 'myapi', keys: ['my-model'], table: {offPeak: {input: 2, output: 8}}}]}
  });
  const h = harness({'qp_token_speed_pricing': overlay});
  const s = start(h); s.model = 'my-model-x'; text(h, s, '一'.repeat(20)); text(h, s, '二'.repeat(20));
  const r = done(h, s, {prompt_tokens: 100, completion_tokens: 120, total_tokens: 220, provider_id: 'my-provider-xyz', model: 'my-model-x'});
  assert.equal(r.channel, 'myapi');
  assert.ok(Math.abs(r.cost - (100 / 1e6 * 2 + 120 / 1e6 * 8)) < 1e-12);
});
test('覆盖层坏 JSON 不崩，内置渠道判定照常', () => {
  const h = harness({'qp_token_speed_pricing': '{oops'});
  const s = start(h); text(h, s, '一'.repeat(20));
  const r = done(h, s, {prompt_tokens: 100, completion_tokens: 120, total_tokens: 220, provider_id: 'deepseek', model: 'deepseek-v4-flash'});
  assert.equal(r.channel, 'deepseek');
});
test('未配置泛渠道时未知 provider 行为不变（other，不算钱）', () => {
  const h = harness();
  const s = start(h); text(h, s, '一'.repeat(20));
  const r = done(h, s, usage(120));
  assert.equal(r.channel, 'other'); assert.equal(r.cost, null);
});

// ════════════════════════════════════════════════════════════
// v1.20.0 · 阿里云百炼 Token Plan（credits）/ 百炼按量 / 账本 / 稳定性
// 官方换算：credits/万tok 数值 = 刊例价 元/百万tok（用量与额度页 qwen3.6-plus 对拍示例实证）
// 时间常量全部显式传入（UTC → 北京 +8h），不依赖跑测试的真实钟点
// ════════════════════════════════════════════════════════════
const DAY_T = Date.UTC(2026, 10, 20, 6, 0, 0);        // 北京 14:00（白天）
const NIGHT_T = Date.UTC(2026, 10, 20, 15, 0, 0);     // 北京 23:00（夜间折扣窗口）
const BUSY_T = Date.UTC(2026, 10, 20, 2, 0, 0);       // 北京 10:00（百炼按量忙时）
const PREVIEW_DAY_T = Date.UTC(2026, 10, 15, 6, 0, 0);   // 11/15 北京 14:00（预览期内）
const PREVIEW_NIGHT_T = Date.UTC(2026, 10, 15, 15, 0, 0); // 11/15 北京 23:00（预览期+夜间）
const AFTER_PREVIEW_T = Date.UTC(2026, 10, 26, 6, 0, 0);  // 11/26（预览期结束）

test('TokenPlan 渠道证据：专属端点 / provider 名 / base_url 优先于 provider 名', () => {
  const h = harness(); const a = h.a;
  assert.equal(a.resolveChannel('bailian-tokenplan', ''), 'tokenplan');
  assert.equal(a.resolveChannel('my-provider', 'https://token-plan.cn-beijing.maas.aliyuncs.com/v1'), 'tokenplan');
  assert.equal(a.resolveChannel('whatever', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), 'dashscope');
  assert.equal(a.resolveChannel('whatever', 'https://coding.dashscope.aliyuncs.com/v1'), 'coding');
  // 同名模型到处卖：端点证据压过 provider 名（与 v1.8.0 修 DeepSeek 误判同一原则）
  assert.equal(a.resolveChannel('deepseek', 'https://token-plan.cn-beijing.maas.aliyuncs.com/v1'), 'tokenplan');
  assert.equal(a.resolveChannel('unknown', ''), 'other'); // 旧行为不变
});
test('TokenPlan 平价模型：qwen3.8-max 刊例价 12/36 → 1.92 credits（三分量明细）', () => {
  const h = harness(); const tp = h.a.calcTokenPlan('qwen3.8-max', 1000, 200, 0, DAY_T);
  assert.ok(Math.abs(tp.credits - 1.92) < 1e-9, 'got ' + tp.credits);
  assert.ok(Math.abs(tp.input - 1.2) < 1e-9 && Math.abs(tp.output - 0.72) < 1e-9);
  assert.equal(tp.factor, 1); assert.equal(tp.tierIdx, 0);
});
test('TokenPlan 缓存命中：qwen3.6-plus 官方对拍口径 2/0.2/12（credits/万tok）', () => {
  const h = harness(); const tp = h.a.calcTokenPlan('qwen3.6-plus', 1000, 100, 500, DAY_T);
  // (500×2 + 500×0.2 + 100×12)/10000 = 0.23
  assert.ok(Math.abs(tp.credits - 0.23) < 1e-9, 'got ' + tp.credits);
  assert.ok(Math.abs(tp.cache - 0.01) < 1e-9);
  assert.equal(tp.cacheAssumed, false);
});
test('TokenPlan 阶梯计价：输入超 256K 跳档（qwen3.6-plus 2/12 → 8/48）', () => {
  const h = harness(); const a = h.a;
  const t1 = a.calcTokenPlan('qwen3.6-plus', 256000, 100, 0, DAY_T);
  const t2 = a.calcTokenPlan('qwen3.6-plus', 256001, 100, 0, DAY_T);
  assert.equal(t1.tierIdx, 0); assert.equal(t2.tierIdx, 1);
  assert.ok(Math.abs(t2.credits - (256001 * 8 + 100 * 48) / 10000) < 1e-9);
  // qwen3.7-plus 阶梯 2/8 → 6/24
  const p2 = a.calcTokenPlan('qwen3.7-plus', 300000, 100, 0, DAY_T);
  assert.ok(Math.abs(p2.credits - (300000 * 6 + 100 * 24) / 10000) < 1e-9);
});
test('TokenPlan 夜间折扣：北京 22–08 点 qwen3.8-max 4 折（时区无关，显式 UTC 验证）', () => {
  const h = harness(); const a = h.a;
  assert.equal(a.beijingHour(NIGHT_T), 23); assert.equal(a.beijingHour(DAY_T), 14);
  assert.equal(a.tpNightActive(NIGHT_T), true); assert.equal(a.tpNightActive(DAY_T), false);
  const tp = a.calcTokenPlan('qwen3.8-max', 1000, 200, 0, NIGHT_T);
  assert.ok(Math.abs(tp.credits - 1.92 * 0.4) < 1e-9, 'got ' + tp.credits);
  assert.ok(tp.factorNote.indexOf('夜间') >= 0);
});
test('TokenPlan deepseek 夜间 5 折 × 忙时刊例价 = 闲时刊例价（官方对拍自洽）', () => {
  const h = harness(); const tp = h.a.calcTokenPlan('deepseek-v4.1-flash', 1000, 200, 0, NIGHT_T);
  // 忙 2/8 × 0.5 = 闲 1/4 → (1000×1 + 200×4)/10000 = 0.18
  assert.ok(Math.abs(tp.credits - 0.18) < 1e-9, 'got ' + tp.credits);
});
test('TokenPlan 预览期：qwen4-max-preview 2 折，夜间再 4 折（官方叠加 0.8 折），期外回落', () => {
  const h = harness(); const a = h.a;
  const base = (1000 * 10 + 200 * 30) / 10000; // 1.6（按 qwen4-max 刊例价，assumedBase 标注）
  const d = a.calcTokenPlan('qwen4-max-preview', 1000, 200, 0, PREVIEW_DAY_T);
  const n = a.calcTokenPlan('qwen4-max-preview', 1000, 200, 0, PREVIEW_NIGHT_T);
  const after = a.calcTokenPlan('qwen4-max-preview', 1000, 200, 0, AFTER_PREVIEW_T);
  assert.ok(Math.abs(d.credits - base * 0.2) < 1e-9, 'day got ' + d.credits);
  assert.ok(Math.abs(n.credits - base * 0.08) < 1e-9, 'night got ' + n.credits);
  assert.ok(Math.abs(after.credits - base) < 1e-9, 'after got ' + after.credits);
  assert.equal(d.assumedBase, true);
  // 长名优先：qwen4-max-preview 不被 qwen4-max 条目截胡
  assert.equal(a.tokenplanEntryFor('qwen4-max-preview').assumedBase, true);
  assert.equal(a.tokenplanEntryFor('qwen4-max').assumedBase, undefined);
});
test('TokenPlan auto 路由：给全表参考区间，不假装精确；未入表模型不算钱', () => {
  const h = harness(); const a = h.a;
  assert.equal(a.calcTokenPlan('auto', 1000, 200, 0, DAY_T), null);
  const rg = a.calcTokenPlanRange('auto', 1000, 200, 0, DAY_T);
  assert.ok(rg && rg.lo > 0 && rg.hi > rg.lo);
  assert.equal(a.calcTokenPlan('qwen-image-3.0', 1000, 200, 0, DAY_T), null); // 图像模型不在文本价表
  const m = a.moneyFields('tokenplan', 'qwen-image-3.0', 1000, 200, 0);
  assert.equal(m.cost, null); assert.equal(m.priceMissing, true); assert.equal(m.costUnit, 'credits');
});
test('百炼按量（dashscope）：人民币刊例价，deepseek 系忙/闲时，qwen 系恒价', () => {
  const h = harness(); const a = h.a;
  const busy = a.calcDashscope('deepseek-v4.1-flash', 1000, 200, 0, BUSY_T);
  const night = a.calcDashscope('deepseek-v4.1-flash', 1000, 200, 0, NIGHT_T);
  assert.ok(Math.abs(busy - (1000 * 2 + 200 * 8) / 1e6) < 1e-12);
  assert.ok(Math.abs(night - (1000 * 1 + 200 * 4) / 1e6) < 1e-12);
  // Token Plan 的夜间 4 折不适用于按量渠道（两套体系独立）
  const qd = a.calcDashscope('qwen3.8-max', 1000, 200, 0, DAY_T);
  const qn = a.calcDashscope('qwen3.8-max', 1000, 200, 0, NIGHT_T);
  assert.ok(Math.abs(qd - qn) < 1e-12);
});
test('TokenPlan 端到端：usage.provider_id 实证 → credits 落库 + 三分量 + 燃烧率', () => {
  const h = harness(); const a = h.a; const s = start(h);
  event(h, s, {type: 'model', model: 'qwen3.8-max'});
  text(h, s, '一'.repeat(50));
  const r = done(h, s, {prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, provider_id: 'bailian-tokenplan'});
  assert.equal(r.channel, 'tokenplan'); assert.equal(r.costUnit, 'credits');
  const expect = a.calcTokenPlan('qwen3.8-max', 1000, 200, 0); // 与 endTurn 同一时刻口径
  assert.ok(Math.abs(r.cost - expect.credits) < 1e-9, 'got ' + r.cost);
  assert.ok(r.tp && r.tp.input > 0 && r.tp.output > 0);
  const burn = a.burnRateOf('tokenplan', 'qwen3.8-max', 100, 1000);
  assert.ok(burn && burn.unit === 'credits/min' && burn.value > 0);
});
test('会话账本：sid+turnKey upsert 去重（刷新恢复不重复计账）、零产出不入账、今日聚合', () => {
  const h = harness(); const a = h.a;
  const base = {ts: Date.now(), model: 'qwen3.8-max', channel: 'tokenplan', outputTokens: 200, cost: 1.92, costUnit: 'credits', afp: null};
  a.appendLedger('s1', Object.assign({}, base, {turnKey: 'tk1', messageId: 'display-a'}));
  a.appendLedger('s1', Object.assign({}, base, {turnKey: 'tk1', messageId: 'display-b'})); // 同回合换了 display id
  assert.equal(a.loadLedger().length, 1);
  a.appendLedger('s1', Object.assign({}, base, {turnKey: 'tk2', messageId: 'm2', cost: 0.5}));
  a.appendLedger('s1', Object.assign({}, base, {outputTokens: 0})); // 零产出跳过
  assert.equal(a.loadLedger().length, 2);
  const today = a.ledgerToday();
  assert.equal(today.turns, 2); assert.equal(today.out, 400);
  assert.ok(Math.abs(today.credits - 2.42) < 1e-9);
  assert.equal(today.cny, 0); assert.equal(today.plan, 0);
});
test('TokenPlan 覆盖层：用户条目前置优先命中；坏 tiers 整份忽略不崩', () => {
  const h = harness({'qp_token_speed_pricing': JSON.stringify({tokenplan: {models: [{keys: ['my-tp-model'], tiers: [{upTo: Infinity, input: 1, output: 2}]}]}})});
  const tp = h.a.calcTokenPlan('my-tp-model', 10000, 10000, 0, DAY_T);
  assert.ok(tp && Math.abs(tp.credits - 3) < 1e-9);
  assert.ok(h.a.calcTokenPlan('qwen3.8-max', 1000, 200, 0, DAY_T)); // 内置表不丢
  const h2 = harness({'qp_token_speed_pricing': JSON.stringify({tokenplan: {models: [{keys: ['bad-model']}]}})}); // 缺 tiers
  assert.equal(h2.a.calcTokenPlan('bad-model', 100, 100, 0, DAY_T), null);
  assert.ok(h2.a.calcTokenPlan('qwen3.8-max', 1000, 200, 0, DAY_T));
});
test('稳定性：过期纪元的 clone 流必须 cancel（tee 缓冲不再累积整条响应）', async () => {
  const h = harness(); const a = h.a; const s = start(h);
  s.epoch = 5; // 模拟已切到新回合
  let cancelled = false;
  const reader = {read: () => new Promise(() => {}), cancel: () => {cancelled = true; return Promise.resolve();}, releaseLock(){}};
  a.monitorStream({body: {getReader: () => reader}}, h.at(), s, 3);
  await settle();
  assert.equal(cancelled, true);
});
test('稳定性：localStorage 配额溢出丢最旧一半重试，新结果仍落库', () => {
  const h = harness(); const a = h.a;
  for (let i = 1; i <= 4; i++) a.saveLastResult('s' + i, {ts: i, outputTokens: i});
  const orig = h.ctx.localStorage.setItem; let throws = 1;
  h.ctx.localStorage.setItem = function (k, v) {
    if (k === 'qp_token_speed_by_session' && throws > 0) {throws--; throw new Error('QuotaExceededError');}
    return orig.call(this, k, v);
  };
  a.saveLastResult('s5', {ts: 5, outputTokens: 5});
  h.ctx.localStorage.setItem = orig;
  assert.ok(a.loadLastResult('s5'), '新结果必须保住');
  assert.equal(a.loadLastResult('s1'), null, '最旧的可被牺牲');
});
test('UI 语义：credits 面板有刊例价折算与三分量条；plan 面板全篇无 ¥；cny 面板有费用', () => {
  const h = harness(); const a = h.a;
  const common = {status: 'done', tokenSource: 'usage', outputTokens: 200, tokens: 200, toolTokens: 0,
    promptTokens: 1000, total: 1200, cacheHit: 0, segments: [], ttft: 100, seconds: 2, pauseSec: 0,
    modelWaitSec: 0, peak: 100, avg: 100, genSpeed: 100, attached: false, replayTokens: 0,
    ts: Date.now(), originKnown: true, errMsg: '', endCause: 'stream_end'};
  const creditsHtml = a.buildDetailHead(Object.assign({}, common, {model: 'qwen3.8-max', channel: 'tokenplan',
    cost: 1.92, costUnit: 'credits', afp: null,
    tp: {input: 1.2, cache: 0, output: 0.72, factor: 1, factorNote: '', tierIdx: 0, cacheAssumed: false, assumedBase: false}}));
  assert.ok(creditsHtml.includes('Credits 消耗') && creditsHtml.includes('刊例价') && creditsHtml.includes('Token Plan'));
  assert.ok(creditsHtml.includes('Credits 构成') && creditsHtml.includes('qp-tp-fill'));
  assert.ok(!creditsHtml.includes('套餐抵扣'));
  const planHtml = a.buildDetailHead(Object.assign({}, common, {model: 'glm-5.3', channel: 'plan', afp: 0.06, cost: null, costUnit: ''}));
  assert.ok(planHtml.includes('套餐抵扣') && planHtml.includes('额度'));
  assert.ok(!planHtml.includes('¥'), 'plan 面板全篇不得出现 ¥（摊销/账本只对 credits 开放）');
  const cnyHtml = a.buildDetailHead(Object.assign({}, common, {model: 'deepseek-v4-flash', channel: 'deepseek', cost: 0.0012, costUnit: 'cny', afp: null}));
  assert.ok(cnyHtml.includes('费用') && cnyHtml.includes('¥') && cnyHtml.includes('DeepSeek 官方'));
  // 悬浮条费用 chip：credits 金 ◈ / plan ▣ / 无钱不显示
  assert.ok(a.costChipHtml({cost: 1.92, costUnit: 'credits'}).includes('◈'));
  assert.ok(a.costChipHtml({afp: 0.06}).includes('▣'));
  assert.equal(a.costChipHtml({}), '');
});
test('UI 语义：今日账本进面板，credits 存在时才有档位摊销选择', () => {
  const h = harness(); const a = h.a;
  a.appendLedger('s1', {ts: Date.now(), turnKey: 'tk1', model: 'qwen3.8-max', channel: 'tokenplan', outputTokens: 200, cost: 1.92, costUnit: 'credits', afp: null});
  const html = a.buildDetailHead({status: 'done', model: 'qwen3.8-max', channel: 'tokenplan', cost: 1.92, costUnit: 'credits', afp: null,
    tp: {input: 1.2, cache: 0, output: 0.72, factor: 1, factorNote: '', tierIdx: 0, cacheAssumed: false, assumedBase: false},
    tokenSource: 'usage', outputTokens: 200, tokens: 200, toolTokens: 0, promptTokens: 1000, total: 1200, cacheHit: 0,
    segments: [], ttft: 100, seconds: 2, pauseSec: 0, modelWaitSec: 0, peak: 100, avg: 100, genSpeed: 100,
    attached: false, replayTokens: 0, ts: Date.now(), originKnown: true});
  assert.ok(html.includes('今日消耗') && html.includes('qp-tp-tier'));
  // 纯套餐账本：无 credits → 无摊销选择、无 ¥
  const h2 = harness(); const a2 = h2.a;
  a2.appendLedger('s1', {ts: Date.now(), turnKey: 'tkp', model: 'glm-5.3', channel: 'plan', outputTokens: 200, cost: null, costUnit: '', afp: 0.06});
  const html2 = a2.buildDetailHead({status: 'done', model: 'glm-5.3', channel: 'plan', afp: 0.06, cost: null, costUnit: '',
    tokenSource: 'usage', outputTokens: 200, tokens: 200, toolTokens: 0, promptTokens: 1000, total: 1200, cacheHit: 0,
    segments: [], ttft: 100, seconds: 2, pauseSec: 0, modelWaitSec: 0, peak: 100, avg: 100, genSpeed: 100,
    attached: false, replayTokens: 0, ts: Date.now(), originKnown: true});
  assert.ok(html2.includes('今日消耗'));
  assert.ok(!html2.includes('qp-tp-tier') && !html2.includes('¥'));
});
test('USD 渠道识别：只认 provider/端点证据；Vertex 不误判；第三方转售不靠模型名猜', () => {
  const a = harness().a;
  assert.equal(a.resolveChannel('openai', 'https://api.openai.com/v1'), 'openai');
  assert.equal(a.resolveChannel('', 'https://api.openai.com/v1'), 'openai'); // 纯端点证据
  assert.equal(a.resolveChannel('anthropic', 'https://api.anthropic.com'), 'anthropic');
  assert.equal(a.resolveChannel('gemini', 'https://generativelanguage.googleapis.com/v1beta'), 'google');
  assert.equal(a.resolveChannel('google-vertex', 'https://aiplatform.googleapis.com'), 'other'); // Vertex 价不同，不套 Gemini 标准价
  assert.equal(a.resolveChannel('some-reseller', 'https://api.example.com'), 'other'); // 卖 gpt 也不靠名字猜成 openai
  assert.equal(a.resolveChannel('bailian-tokenplan', 'https://token-plan.cn-beijing.maas.aliyuncs.com'), 'tokenplan'); // 阿里门控不被抢
  assert.equal(a.costUnitFor('openai', 'gpt-4o'), 'usd');
  assert.equal(a.channelHasPriceTable('anthropic'), true);
});
test('USD 计价 golden：OpenAI/Anthropic/Google 标准档三分量（美元/百万tok）', () => {
  const a = harness().a; const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, x + ' != ' + y);
  near(a.calcUsd('openai', 'gpt-4o', 1000, 200, 0), (1000 * 2.5 + 200 * 10) / 1e6);
  near(a.calcUsd('openai', 'gpt-4o', 1000, 200, 500), (500 * 2.5 + 500 * 1.25 + 200 * 10) / 1e6); // 缓存命中按 cacheHit
  near(a.calcUsd('openai', 'gpt-5-mini', 1000, 200, 0), (1000 * 0.25 + 200 * 2) / 1e6); // 长名优先，不被 gpt-5 抢
  near(a.calcUsd('anthropic', 'claude-sonnet-4-5', 1000, 200, 0), (1000 * 3 + 200 * 15) / 1e6);
  near(a.calcUsd('anthropic', 'claude-opus-4-5', 1000, 200, 0), (1000 * 5 + 200 * 25) / 1e6);
  near(a.calcUsd('anthropic', 'claude-3-opus', 1000, 200, 0), (1000 * 15 + 200 * 75) / 1e6); // 泛 opus 兜底
  near(a.calcUsd('google', 'gemini-2.5-flash', 1000, 200, 0), (1000 * 0.3 + 200 * 2.5) / 1e6);
  near(a.calcUsd('google', 'gemini-2.5-pro', 1000, 200, 0), (1000 * 1.25 + 200 * 10) / 1e6);
});
test('USD 长上下文阶梯：gpt-5.4 >272K、gemini-2.5-pro >200K 跳档', () => {
  const a = harness().a; const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, x + ' != ' + y);
  near(a.calcUsd('openai', 'gpt-5.4', 272000, 0, 0), 272000 * 2.5 / 1e6);
  near(a.calcUsd('openai', 'gpt-5.4', 272001, 0, 0), 272001 * 5 / 1e6);
  near(a.calcUsd('google', 'gemini-2.5-pro', 200000, 0, 0), 200000 * 1.25 / 1e6);
  near(a.calcUsd('google', 'gemini-2.5-pro', 200001, 0, 0), 200001 * 2.5 / 1e6);
});
test('USD 不猜纪律：未入表模型不算钱，moneyFields 标 priceMissing', () => {
  const a = harness().a;
  assert.equal(a.calcUsd('openai', 'totally-unknown-xyz', 1000, 200, 0), null);
  const mf = a.moneyFields('openai', 'totally-unknown-xyz', 1000, 200, 0);
  assert.equal(mf.cost, null); assert.equal(mf.costUnit, 'usd'); assert.equal(mf.priceMissing, true);
  assert.equal(a.burnRateOf('openai', 'totally-unknown-xyz', 100, 1000), null);
});
test('USD 端到端 + 多货币账本分桶：usd/cny/credits 各算各的不混算', () => {
  const h = harness(); const a = h.a; const s = start(h);
  event(h, s, {type: 'model', model: 'gpt-4o'});
  text(h, s, '一'.repeat(50));
  const r = done(h, s, {prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, provider_id: 'openai'});
  assert.equal(r.channel, 'openai'); assert.equal(r.costUnit, 'usd');
  assert.ok(Math.abs(r.cost - 0.0045) < 1e-9, 'got ' + r.cost);
  const burn = a.burnRateOf('openai', 'gpt-4o', 100, 1000);
  assert.ok(burn && burn.unit === 'usd/min' && Math.abs(burn.value - 0.06) < 1e-9);
  const h2 = harness(); const a2 = h2.a; const ts = Date.now(); // 独立账本，避免端到端回合自动入账污染
  a2.appendLedger('s1', {ts, turnKey: 'u1', model: 'gpt-4o', channel: 'openai', outputTokens: 200, cost: 0.0045, costUnit: 'usd', afp: null});
  a2.appendLedger('s1', {ts, turnKey: 'c1', model: 'deepseek-v4-flash', channel: 'deepseek', outputTokens: 200, cost: 0.0012, costUnit: 'cny', afp: null});
  a2.appendLedger('s1', {ts, turnKey: 'k1', model: 'qwen3.8-max', channel: 'tokenplan', outputTokens: 200, cost: 1.92, costUnit: 'credits', afp: null});
  const t = a2.ledgerToday();
  assert.equal(t.turns, 3); assert.equal(t.out, 600);
  assert.ok(Math.abs(t.usd - 0.0045) < 1e-9); assert.ok(Math.abs(t.cny - 0.0012) < 1e-9); assert.ok(Math.abs(t.credits - 1.92) < 1e-9);
  assert.ok(Math.abs(t.byModel['gpt-4o'].usd - 0.0045) < 1e-9); assert.equal(t.byModel['gpt-4o'].cny, 0);
});
test('USD UI 语义：面板/费用 chip/账本显示 $，无 ¥、无 credits 摊销选择', () => {
  const h = harness(); const a = h.a;
  a.appendLedger('s1', {ts: Date.now(), turnKey: 'u1', model: 'gpt-4o', channel: 'openai', outputTokens: 200, cost: 0.0045, costUnit: 'usd', afp: null});
  const html = a.buildDetailHead({status: 'done', model: 'gpt-4o', channel: 'openai', cost: 0.0045, costUnit: 'usd', afp: null,
    tokenSource: 'usage', outputTokens: 200, tokens: 200, toolTokens: 0, promptTokens: 1000, total: 1200, cacheHit: 0,
    segments: [], ttft: 100, seconds: 2, pauseSec: 0, modelWaitSec: 0, peak: 100, avg: 100, genSpeed: 100,
    attached: false, replayTokens: 0, ts: Date.now(), originKnown: true});
  assert.ok(html.includes('费用') && html.includes('$') && html.includes('OpenAI'));
  assert.ok(html.includes('今日消耗') && !html.includes('qp-tp-tier'));
  assert.ok(!html.includes('¥'), 'USD 面板全篇不得出现 ¥');
  assert.ok(a.costChipHtml({cost: 0.0045, costUnit: 'usd'}).includes('$'));
});
test('USD 覆盖层：用户条目前置优先命中；坏 tiers 整份忽略不崩，内置表不丢', () => {
  const h = harness({'qp_token_speed_pricing': JSON.stringify({usd: {openai: {models: [{keys: ['my-gpt'], tiers: [{upTo: Infinity, input: 1, output: 2}]}]}}})});
  assert.ok(Math.abs(h.a.calcUsd('openai', 'my-gpt', 10000, 10000, 0) - 0.03) < 1e-9);
  assert.ok(Math.abs(h.a.calcUsd('openai', 'gpt-4o', 1000, 200, 0) - 0.0045) < 1e-9); // 内置不丢
  const h2 = harness({'qp_token_speed_pricing': JSON.stringify({usd: {openai: {models: [{keys: ['bad-gpt']}]}}})}); // 缺 tiers
  assert.equal(h2.a.calcUsd('openai', 'bad-gpt', 100, 100, 0), null);
  assert.ok(h2.a.calcUsd('openai', 'gpt-4o', 1000, 200, 0) != null);
});
(async()=>{
  let failed=0;
  for(const [name,fn] of tests) {try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+' :: '+e.message);}}
  console.log(`${tests.length-failed}/${tests.length} scenarios passed`);process.exitCode=failed?1:0;
})();
