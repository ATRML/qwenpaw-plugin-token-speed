// localStorage 持久化（按会话，原 01-core 结果存储部分）
import { getSessionId } from "./session.js";

var LS_KEY = "qp_token_speed_by_session";
var LS_MAX_SESSIONS = 80;

// 解析结果按 raw 字符串做内存缓存。面板开着时 loadLastResult 每 600ms 被调一次，
// 旧版每次重新 JSON.parse 整块（80 会话可达上百 KB）——纯浪费。写入即失效。
var lsCache = null;
function readAllResults() {
  try {
    var raw = localStorage.getItem(LS_KEY) || "{}";
    if (lsCache && lsCache.raw === raw) return lsCache.obj;
    var obj = JSON.parse(raw) || {};
    lsCache = { raw: raw, obj: obj };
    return obj;
  } catch (e) {
    return {};
  }
}
// 配额溢出不再静默丢结果——丢最旧一半重试一次（LS_MAX_SESSIONS 之外的兜底）
function writeAllResults(all) {
  var raw = JSON.stringify(all);
  try {
    localStorage.setItem(LS_KEY, raw);
  } catch (e) {
    try {
      var keys = Object.keys(all);
      keys.sort(function (a, b) {
        return (all[a].ts || 0) - (all[b].ts || 0);
      });
      var drop = Math.ceil(keys.length / 2);
      for (var i = 0; i < drop; i++) delete all[keys[i]];
      raw = JSON.stringify(all);
      localStorage.setItem(LS_KEY, raw);
    } catch (e2) {
      return false;
    }
  }
  lsCache = { raw: raw, obj: all };
  return true;
}

export function loadLastResult(sid) {
  var all = readAllResults();
  return all[sid || getSessionId()] || null;
}
// ★ 显式传 sid：结果跟着"流所属会话"走，而不是"用户当前看的会话"
export function saveLastResult(sid, r) {
  var all = readAllResults();
  all[sid] = r;
  var keys = Object.keys(all);
  if (keys.length > LS_MAX_SESSIONS) {
    keys.sort(function (a, b) {
      return (all[a].ts || 0) - (all[b].ts || 0);
    });
    while (keys.length > LS_MAX_SESSIONS) delete all[keys.shift()];
  }
  writeAllResults(all);
}