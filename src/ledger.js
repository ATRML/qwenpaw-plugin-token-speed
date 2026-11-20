// 会话账本：近期回合滚动流水（面板"今日消耗"聚合的数据源，原 01-core 账本部分）
// 设计：只存聚合需要的最小字段（不存分段/全文），300 条上限 ≈ 几十 KB；
// 按 sid+turnKey upsert——刷新后历史恢复同一回合不会重复计账，retro 补算就地更新金额。
var LEDGER_KEY = "qp_token_speed_ledger";
var LEDGER_MAX = 300;

export function loadLedger() {
  try {
    var a = JSON.parse(localStorage.getItem(LEDGER_KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}
function saveLedger(a) {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(a));
  } catch (e) {
    try {
      localStorage.setItem(LEDGER_KEY, JSON.stringify(a.slice(-Math.floor(LEDGER_MAX / 2))));
    } catch (e2) {
      /* ignore */
    }
  }
}
function ledgerEntryOf(sid, r) {
  return {
    ts: r.ts || Date.now(),
    sid: sid || "",
    mid: r.turnKey || r.messageId || "",
    model: r.model || "",
    channel: r.channel || "",
    out: r.outputTokens || 0,
    credits: r.costUnit === "credits" ? r.cost : null,
    cny: r.costUnit === "cny" ? r.cost : null,
    plan: r.afp != null ? r.afp : null
  };
}
export function appendLedger(sid, r) {
  if (!r || !(r.outputTokens > 0)) return; // 零产出的错误/刷新中止不入账
  var a = loadLedger();
  // turnKey（后端 original_id）优先：历史恢复的 display message.id 每次 fetch 都变，
  // 用它去重会把同一回合重复计账；实测回合的 messageId 是后端稳定 ID
  var key = (sid || "") + "|" + (r.turnKey || r.messageId || "ts:" + (r.ts || 0));
  var hit = -1;
  for (var i = a.length - 1; i >= 0; i--) {
    var k = (a[i].sid || "") + "|" + (a[i].mid || "ts:" + (a[i].ts || 0));
    if (k === key) {
      hit = i;
      break;
    }
  }
  var e = ledgerEntryOf(sid, r);
  if (hit >= 0) a[hit] = e;
  else a.push(e);
  if (a.length > LEDGER_MAX) a = a.slice(a.length - LEDGER_MAX);
  saveLedger(a);
}
// 今日聚合（本地零点起）：{turns, out, credits, cny, plan, byModel}
export function ledgerToday() {
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  var start = d.getTime();
  var a = loadLedger();
  var sum = { turns: 0, out: 0, credits: 0, cny: 0, plan: 0, byModel: {} };
  for (var i = 0; i < a.length; i++) {
    var e = a[i];
    if (!e || (e.ts || 0) < start) continue;
    sum.turns++;
    sum.out += e.out || 0;
    if (e.credits != null) sum.credits += e.credits;
    if (e.cny != null) sum.cny += e.cny;
    if (e.plan != null) sum.plan += e.plan;
    var mk = e.model || "未知";
    var bm = sum.byModel[mk] || (sum.byModel[mk] = { turns: 0, out: 0, credits: 0, cny: 0, plan: 0 });
    bm.turns++;
    bm.out += e.out || 0;
    if (e.credits != null) bm.credits += e.credits;
    if (e.cny != null) bm.cny += e.cny;
    if (e.plan != null) bm.plan += e.plan;
  }
  return sum;
}