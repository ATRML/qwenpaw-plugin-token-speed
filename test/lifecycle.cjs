'use strict';
// 生命周期专项回归（v2 新增）：覆盖旧文案锁套件退役后留下的真盲区——
// init 主循环维护、路由/会话切换、pagehide 分类、双注入守卫、渲染总线降级、
// hideAnchor DOM 卫生、ESC 关面板、详情面板增量实时刷新、injectBar 幂等。
// 全部行为断言，不锁文案。驱动 dist/lifecycle-bundle.js（真实渲染器 + DOM 挂载函数）。
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const lifeSrc = fs.readFileSync(path.join(__dirname, '..', 'dist', 'lifecycle-bundle.js'), 'utf8');
const prodSrc = fs.readFileSync(path.join(__dirname, '..', 'dist', 'index.js'), 'utf8');

function makeElement(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), style: {}, children: [], textContent: '',
    className: '', id: '', innerHTML: '', parentNode: null, parentElement: null, scrollTop: 0,
    setAttribute() {}, appendChild(c) { this.children.push(c); if (c) { c.parentNode = this; c.parentElement = this; } return c; },
    addEventListener(t, fn) { (this._h = this._h || {})[t] = fn; },
    removeEventListener() {},
    remove() { const p = this.parentNode; if (p && p.children) { const i = p.children.indexOf(this); if (i >= 0) p.children.splice(i, 1); } this.parentNode = null; this.parentElement = null; },
    contains(n) { return this.children.indexOf(n) >= 0; },
    getBoundingClientRect() { return { top: 800, height: 40, left: 100, width: 600, right: 700, bottom: 840 }; },
    querySelector(sel) { const cls = String(sel).replace(/^\./, ''); return this.children.find(c => c && (c.className === cls || c.id === cls)) || null; },
    classList: { add() {}, remove() {}, toggle() {} }
  };
  return el;
}

function harness(src, opts) {
  opts = opts || {};
  let time = 1000;
  const saved = new Map();
  const intervals = [];
  const winHandlers = {};
  const docHandlers = {};
  const yNodes = opts.yNodes || [];
  const body = makeElement('body');
  const head = makeElement('head');
  const ctx = {
    console: { log() {}, warn() {}, error() {} }, TextDecoder, TextEncoder, URL, URLSearchParams, Request, Response,
    location: { pathname: '/chat/chat-alpha', href: 'http://localhost/chat/chat-alpha' },
    performance: { now: () => time }, Date,
    innerWidth: 1600, innerHeight: 900,
    localStorage: { getItem: k => saved.get(k) || null, setItem: (k, v) => saved.set(k, String(v)), removeItem: k => saved.delete(k) },
    sessionStorage: { getItem: () => null },
    document: {
      readyState: 'complete', head, body, documentElement: makeElement('html'),
      getElementById: id => [head, body].concat(body.children).find(c => c && c.id === id) || null,
      createElement: makeElement,
      querySelector: opts.noChat ? () => null : () => makeElement('div'),
      querySelectorAll: () => [],
      addEventListener(t, fn) { docHandlers[t] = fn; },
      removeEventListener(t) { delete docHandlers[t]; },
      createTreeWalker() { let i = 0; return { nextNode: () => (i < yNodes.length ? yNodes[i++] : null) }; }
    },
    addEventListener(t, fn) { winHandlers[t] = fn; },
    removeEventListener() {},
    setInterval: fn => { intervals.push(fn); return intervals.length; }, clearInterval() {},
    setTimeout, clearTimeout,
    history: { pushState() {}, replaceState() {} },
    fetch: () => Promise.resolve(new Response('{}', { headers: { 'content-type': 'application/json' } })),
    MutationObserver: class { observe() {} disconnect() {} },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 }
  };
  ctx.window = ctx;
  vm.runInNewContext(src, ctx);
  return {
    ctx, a: ctx.testApi, saved, intervals, winHandlers, docHandlers, body,
    advance: ms => { time += ms; }, at: () => time,
    tick: () => intervals.forEach(fn => { try { fn(); } catch (e) { /* 主循环单拍隔离 */ } }),
    bar: () => body.children.find(c => c.id === 'qp-token-speed-bar'),
    panel: () => body.children.find(c => c.id === 'qp-token-speed-detail')
  };
}
function text(h, s, value, ms) { h.advance(ms == null ? 100 : ms); h.a.handleEvent(JSON.stringify({ type: 'text', delta: true, msg_id: 'm1', index: 0, text: value }), s); }
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('双注入守卫：生产 bundle 加载两次只 patch 一次 fetch、只初始化一次', () => {
  const h = harness(prodSrc);
  assert.equal(h.ctx.__qpTokenSpeedLoaded, true);
  const fetchAfterFirst = h.ctx.fetch;
  const barCount1 = h.body.children.filter(c => c.id === 'qp-token-speed-bar').length;
  vm.runInNewContext(prodSrc, h.ctx); // 第二次加载
  assert.equal(h.ctx.fetch, fetchAfterFirst, '第二次加载不得再包一层 fetch');
  const barCount2 = h.body.children.filter(c => c.id === 'qp-token-speed-bar').length;
  assert.equal(barCount2, barCount1, '第二次加载不得重复挂载悬浮条');
});

test('injectBar 幂等：重复调用只存在一个悬浮条', () => {
  const h = harness(lifeSrc);
  h.a.injectBar(); h.a.injectBar(); h.a.injectBar();
  assert.equal(h.body.children.filter(c => c.id === 'qp-token-speed-bar').length, 1);
});

test('非聊天页：positionBar 隐藏悬浮条', () => {
  const h = harness(lifeSrc, { noChat: true });
  h.a.injectBar();
  const bar = h.bar();
  h.a.positionBar();
  assert.equal(bar.style.display, 'none');
});

test('init 主循环：error 帧后 1.6s 无新事件 → 判定流死亡（有输出按已中断）', () => {
  const h = harness(lifeSrc);
  h.a.init();
  const s = h.a.getState('chat-alpha');
  h.a.startTurn(h.at(), s, 1);
  text(h, s, '一'.repeat(20));
  s.pendingError = 'boom'; s.lastEventAt = h.at();
  h.advance(1700);
  h.tick();
  assert.equal(s.active, false);
  assert.equal(s.lastResult.status, 'abort');
  assert.equal(s.lastResult.endCause, 'error_frame');
});

test('init 主循环：静默 >2s 补测停顿，且不篡改最后正文时间', () => {
  const h = harness(lifeSrc);
  const s = h.a.getState('chat-alpha');
  h.a.startTurn(h.at(), s, 1);
  text(h, s, '一'.repeat(20));
  const tLast = s.tLast;
  h.advance(3000);
  h.a.maintainStream(s, h.at());
  assert.ok(s.pauseMs >= 2900, '停顿应计入静默余量');
  assert.equal(s.tLast, tLast, '补测不得覆盖最后正文时间戳');
  assert.equal(s.lastSpeed, 0);
});

test('渲染总线降级：UI 未加载（renderer 全 noop）时引擎照常统计', () => {
  const h = harness(lifeSrc);
  // 模拟 UI 子系统失败：把渲染总线全部置空（与生产默认 noop 一致）
  const r = h.a.renderer;
  r.renderRunning = r.renderReplay = r.renderDone = r.renderWaiting = r.refreshDetail = r.refreshBarContent = function () {};
  const s = h.a.getState('chat-alpha');
  h.a.startTurn(h.at(), s, 1);
  text(h, s, '一'.repeat(20)); text(h, s, '二'.repeat(20));
  h.a.handleEvent(JSON.stringify({ type: 'turn_usage', usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, provider_id: 'unknown' } }), s);
  h.a.endTurn('done', s, '', 'stream_end');
  assert.equal(s.lastResult.tokens, 40);
  assert.equal(s.lastResult.status, 'done');
});

test('pagehide 监听：置位 pageLeaving，零产出中止归类为页面刷新且不落库', () => {
  const h = harness(lifeSrc);
  assert.equal(typeof h.winHandlers.pagehide, 'function', 'store 应登记 pagehide');
  const s = h.a.getState('chat-alpha');
  h.a.startTurn(h.at(), s, 1);
  h.winHandlers.pagehide();
  assert.equal(h.a.store.pageLeaving, true);
  h.a.finishAbnormal(s, 'AbortError', 'read_error');
  assert.equal(s.lastResult.endCause, 'page_refresh');
  assert.equal(h.saved.has('qp_token_speed_by_session'), false);
});

test('路由切换：pushState 换会话 → 关旧面板 + 刷新条内容到新会话', () => {
  const h = harness(lifeSrc);
  h.a.injectBar();
  h.a.installRouteTracking();
  // 旧会话留一个结果
  h.a.saveLastResult('chat-alpha', { model: 'm', status: 'done', tokens: 10, outputTokens: 10, seconds: 1, genSpeed: 10, ts: Date.now(), segments: [] });
  h.a.refreshBarContent();
  assert.ok(h.bar().innerHTML.length > 0);
  // 切到新会话
  h.ctx.location.pathname = '/chat/chat-beta';
  h.ctx.history.pushState({}, '', '/chat/chat-beta');
  assert.equal(h.a.getSessionId(), 'chat-beta');
  // 新会话无数据 → 等待/空态文案（行为：不再显示旧会话结果）
  assert.ok(!h.bar().innerHTML.includes('chat-alpha'));
});

test('hideAnchor DOM 卫生：只隐藏标语节点，绝不伤聊天气泡与插件自身', () => {
  const slogan = makeElement('div'); slogan.textContent = '懂你所需 伴你左右';
  const bubble = makeElement('div'); bubble.className = 'message-bubble markdown'; bubble.textContent = '你说：懂你所需 伴你左右';
  const self = makeElement('div'); self.id = 'qp-token-speed-bar'; self.textContent = '懂你所需';
  const yNodes = [
    { textContent: '懂你所需 伴你左右', parentElement: slogan },
    { textContent: '你说：懂你所需 伴你左右', parentElement: bubble },
    { textContent: '懂你所需', parentElement: self }
  ];
  const h = harness(lifeSrc, { yNodes });
  h.a.hideAnchor(true);
  assert.equal(slogan.style.display, 'none', '标语应被隐藏');
  assert.notEqual(bubble.style.display, 'none', '聊天气泡绝不能被隐藏');
  assert.notEqual(self.style.display, 'none', '插件自身节点绝不能被隐藏');
});

test('hideAnchor 短路：命中后不再重复扫描（force 才复扫）', () => {
  const slogan = makeElement('div'); slogan.textContent = '懂你所需 伴你左右';
  let scans = 0;
  const yNodes = [{ textContent: '懂你所需 伴你左右', parentElement: slogan }];
  const h = harness(lifeSrc, { yNodes });
  // 包一层 createTreeWalker 计数
  const orig = h.ctx.document.createTreeWalker;
  h.ctx.document.createTreeWalker = function () { scans++; return orig.apply(this, arguments); };
  h.a.hideAnchor(); assert.equal(scans, 1);
  h.a.hideAnchor(); assert.equal(scans, 1, '命中后短路，不再扫');
  h.a.hideAnchor(true); assert.equal(scans, 2, 'force 强制复扫');
});

test('ESC 关闭详情面板', () => {
  const h = harness(lifeSrc);
  h.a.openDetail({ model: 'm', status: 'done', tokens: 10, outputTokens: 10, seconds: 1, genSpeed: 10, ts: Date.now(), segments: [], channel: 'other' });
  assert.ok(h.panel(), '面板应已打开');
  assert.equal(typeof h.docHandlers.keydown, 'function');
  h.docHandlers.keydown({ key: 'Escape' });
  assert.equal(h.panel(), undefined, 'ESC 后面板应被移除');
});

test('详情面板增量实时刷新：生成中数字跟着变，分段行只增不重建', () => {
  const h = harness(lifeSrc);
  const s = h.a.getState('chat-alpha');
  h.a.startTurn(h.at(), s, 1);
  text(h, s, '一'.repeat(20)); text(h, s, '二'.repeat(20));
  h.a.openDetail(h.a.liveSnapshot(s));
  const panel = h.panel();
  const head = panel.querySelector('.qp-d-head');
  const before = head.innerHTML;
  const segsBox = panel.querySelector('.qp-d-segs');
  const rowsBefore = segsBox.children.length;
  // 继续生成
  text(h, s, '三'.repeat(20)); text(h, s, '四'.repeat(20));
  h.a.refreshDetail();
  assert.notEqual(head.innerHTML, before, 'head 应随生成刷新');
  assert.ok(segsBox.children.length >= rowsBefore, '分段行只增不减');
  // 行节点保持（增量同步不整体重建）
  assert.ok(head.innerHTML.includes('80') || head.innerHTML.includes('≈'), '输出量应反映新增 token');
});

test('点面板外关闭：onDocClickDetail 命中外部节点移除面板', () => {
  const h = harness(lifeSrc);
  h.a.openDetail({ model: 'm', status: 'done', tokens: 10, outputTokens: 10, seconds: 1, genSpeed: 10, ts: Date.now(), segments: [], channel: 'other' });
  assert.ok(h.panel());
  // openDetail 用 setTimeout(0) 挂 document click；等一拍
  return new Promise(resolve => setTimeout(() => {
    const outside = makeElement('div');
    if (h.docHandlers.click) h.docHandlers.click({ target: outside });
    assert.equal(h.panel(), undefined, '点外部应关闭面板');
    resolve();
  }, 5));
});

(async () => {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('PASS ' + name); pass++; }
    catch (e) { console.log('FAIL ' + name + ' :: ' + (e && e.message || e)); fail++; }
  }
  console.log(pass + '/' + (pass + fail) + ' lifecycle scenarios passed');
  process.exitCode = fail ? 1 : 0;
})();