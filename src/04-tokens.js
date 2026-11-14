  // ════════════════════════════════════════════════════════════
  // 04-tokens.js · token 估算（中英混合 + 按模型 ratio 自校准）/ usage 提取
  // ════════════════════════════════════════════════════════════
  // 中英混合 token 估算：中文字符≈1 token，其他字符≈1/4 token，空白忽略
  // v1.5.0：ratio 按模型分表——不同模型的真实压缩比差一倍（glm-5.3 思考流
  // completion/估算≈0.5，flash≈0.9），全局单一 ratio 会互相污染校准
  var RATIO_KEY = "qp_token_speed_ratio";           // 旧标量：作为未知模型的回退
  var RATIO_MAP_KEY = "qp_token_speed_ratio_map";    // 新：{模型小写: ratio}
  var defaultRatio = 1;
  var ratioMap = {};
  try {
    var _rm = JSON.parse(localStorage.getItem(RATIO_MAP_KEY) || "null");
    if (_rm && typeof _rm === "object") ratioMap = _rm;
    defaultRatio = parseFloat(localStorage.getItem(RATIO_KEY)) || 1;
  } catch (e) { /* ignore */ }

  function ratioFor(model) {
    model = String(model || "").toLowerCase();
    if (model && ratioMap[model]) return ratioMap[model];
    return defaultRatio;
  }
  function calibrateRatio(model, newRatio) {
    var old = (model && ratioMap[model]) || defaultRatio;
    var v = old * 0.7 + newRatio * 0.3;
    if (model) {
      ratioMap[model] = v;
      try { localStorage.setItem(RATIO_MAP_KEY, JSON.stringify(ratioMap)); } catch (e) { /* ignore */ }
    } else {
      defaultRatio = v;
      try { localStorage.setItem(RATIO_KEY, defaultRatio.toFixed(4)); } catch (e) { /* ignore */ }
    }
  }

  function rawEstimate(text) {
    var cjk = 0, other = 0;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code >= 0x4e00 && code <= 0x9fff) { cjk++; }
      else if (code > 0x20 && code !== 0x7f) { other++; }
    }
    return cjk + other / 4;
  }
  function estimateTokens(text, model) { return rawEstimate(text) * ratioFor(model); }

  // 从事件里提取精确用量
  function extractUsage(obj) {
    if (!obj || typeof obj !== "object") return null;
    var usage = obj.usage || (obj.data && obj.data.usage) || null;
    var model = obj.model || (obj.data && obj.data.model) || "";
    if (usage && typeof usage === "object") {
      var pt = usage.prompt_tokens, ct = usage.completion_tokens;
      function count(n) { return typeof n === "number" && isFinite(n) && n >= 0; }
      var exact = obj.type === "turn_usage" && usage.estimated !== true;
      if (pt !== undefined && !count(pt) || ct !== undefined && !count(ct)) return null;
      var hit = typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens
              : typeof usage.prompt_cache_hit_tokens === "number" ? usage.prompt_cache_hit_tokens : 0;
      var mName = usage.model_name || model || "";
      // v1.8.0：usage 里带的 provider_id 是"本回合真实渠道"的最强证据（后端日志实测
      // 形如 provider_id/model_name/prompt_tokens/cache_read_tokens/...；后端估算型
      // usage 的这两个字段会是空串，那就别拿它下结论）
      var prov = typeof usage.provider_id === "string" ? usage.provider_id : "";
      if (count(pt) && count(ct)) {
        var total = count(usage.total_tokens) ? usage.total_tokens : pt + ct;
        if (total < pt + ct) return null;
        hit = count(hit) ? Math.min(hit, pt) : 0;
        return { generated: ct, total: total, promptTokens: pt, completionTokens: ct, cacheHit: hit, model: mName, provider: prov, exact: exact };
      }
      var it = usage.input_tokens, ot = usage.output_tokens;
      if (count(it) && count(ot)) {
        return { generated: ot, total: it + ot, promptTokens: it, completionTokens: ot, cacheHit: 0, model: mName, provider: prov, exact: exact };
      }
    }
    return null;
  }
