  // v1.15.0: reserve the stream epoch when a request is SENT, before response headers.
  // The observer reads a cloned response and always returns the original response unchanged.
  function patchFetch() {
    if (typeof window.fetch !== "function") return;
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : String(input && input.url || input || "");
      var method = String(init && init.method || input && input.method || "GET").toUpperCase();
      var meta = {};
      try {
        var body = init && init.body;
        if (typeof body === "string") meta = JSON.parse(body) || {};
      } catch (e) { /* Request body parsing is optional; never affects the host request. */ }
      var sid = String(meta.chat_id || getSessionId());
      if (sid === "default" && meta.session_id) sid = String(meta.session_id);
      if (method === "POST" && /\/console\/chat\/stop(?:\?|$)/.test(url)) {
        try {
          var target = new URL(url, location.href || "http://localhost").searchParams.get("chat_id")
            || meta.chat_id || meta.session_id || sid;
          Object.keys(states).forEach(function (k) {
            var state = states[k];
            if (state && state.active && (k === target || state.requestSessionId === target)) {
              state.userStopped = true; state.endCause = "user_stop";
            }
          });
        } catch (eStop) { /* ignore */ }
        return origFetch.apply(this, arguments);
      }
      if (method !== "POST" || !/\/console\/chat(?:\?|$)/.test(url)) {
        var historyMatch = method === "GET" && /\/api\/chats\/([^/?]+)(?:\?|$)/.exec(url);
        if (historyMatch) {
          var historySid = decodeURIComponent(historyMatch[1]);
          var historyEpoch = states[historySid] ? states[historySid].epoch : 0;
          return origFetch.apply(this, arguments).then(function (response) {
            if (response && response.ok) {
              try {
                response.clone().json().then(function (data) {
                  if ((states[historySid] ? states[historySid].epoch : 0) === historyEpoch) hydrateChatHistory(historySid, data);
                }).catch(function () {});
              } catch (eHistory) { /* observer must not alter the response */ }
            }
            return response;
          });
        }
        return origFetch.apply(this, arguments);
      }
      var startTime = now();
      var myState = getState(sid);
      var myEpoch = ++streamEpoch;
      startTurn(startTime, myState, myEpoch, {reconnect: meta.reconnect === true,
        fresh: meta.reconnect === false || Array.isArray(meta.input)});
      myState.requestSessionId = String(meta.session_id || "");
      pruneStates();
      // Read Request objects through a clone; the original body is never consumed.
      if (!(init && init.body) && input && typeof input.clone === "function") {
        try {
          input.clone().text().then(function (raw) {
            if (myState.epoch !== myEpoch) return;
            try { myState.requestSessionId = String(JSON.parse(raw).session_id || ""); } catch (eJSON) { /* ignore */ }
          }).catch(function () {});
        } catch (eBody) { /* ignore */ }
      }
      try { refreshActiveLlm(true); } catch (eRefresh) { /* ignore */ }
      var promise;
      try { promise = origFetch.apply(this, arguments); }
      catch (error) {
        finishAbnormal(myState, String(error.message || error), "read_error");
        throw error;
      }
      return promise.then(function (resp) {
        if (myState.epoch !== myEpoch) return resp;
        if (!resp || !resp.ok || !resp.body) {
          finishAbnormal(myState, "HTTP " + (resp && resp.status || "no response"), "http_error");
          return resp;
        }
        var ct = "";
        try { ct = String(resp.headers.get("content-type") || "").toLowerCase(); } catch (eHeaders) { /* ignore */ }
        if (ct && ct.indexOf("event-stream") < 0) {
          finishAbnormal(myState, "Response is not an event stream", "content_type");
          return resp;
        }
        try { monitorStream(resp.clone(), startTime, myState, myEpoch); }
        catch (eClone) { finishAbnormal(myState, "Stream observer unavailable", "observer_error"); }
        return resp;
      }, function (error) {
        if (myState.epoch === myEpoch) {
          finishAbnormal(myState, String(error && error.message || error),
            pageLeaving ? "page_refresh" : "read_error");
        }
        throw error;
      });
    };
  }

  function monitorStream(resp, t0, st, epoch) {
    if (!st || st.epoch > epoch) return;
    if (st.epoch !== epoch || !st.active) startTurn(t0, st, epoch);
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buf = "", lines = [], eventType = "", ended = false, receivedAt = 0;
    function stale() { return st.epoch !== epoch; }
    function cancel() {
      try { Promise.resolve(reader.cancel()).catch(function () {}); } catch (e) { /* ignore */ }
    }
    function dispatch() {
      if (!lines.length || stale() || ended) { lines = []; eventType = ""; return; }
      var payload = lines.join("\n"); lines = [];
      if (payload.trim() === "[DONE]") {
        ended = true; finishStream(st); eventType = ""; return;
      }
      // The event: field supplies the type when it is absent from the JSON envelope.
      try {
        if (eventType) {
          var obj = JSON.parse(payload);
          if (obj && typeof obj === "object" && !obj.type) { obj.type = eventType; payload = JSON.stringify(obj); }
        }
        handleEvent(payload, st, receivedAt);
      } catch (eEvent) {
        warnOnce("observer", "统计事件处理失败，已跳过；聊天流继续传递");
      }
      eventType = "";
    }
    function line(value) {
      if (value === "") { dispatch(); return; }
      if (value.charAt(0) === ":") return;
      var colon = value.indexOf(":");
      var field = colon < 0 ? value : value.slice(0, colon);
      var content = colon < 0 ? "" : value.slice(colon + 1).replace(/^ /, "");
      if (field === "data") lines.push(content);
      else if (field === "event") eventType = content;
    }
    function consume(final) {
      var match;
      while ((match = /[\r\n]/.exec(buf))) {
        var index = match.index;
        if (buf[index] === "\r" && index === buf.length - 1 && !final) break;
        var size = buf[index] === "\r" && buf[index + 1] === "\n" ? 2 : 1;
        var value = buf.slice(0, index); buf = buf.slice(index + size);
        line(value);
        if (stale() || ended) return;
      }
      if (final) { if (buf) line(buf); buf = ""; dispatch(); }
    }
    function pump() {
      reader.read().then(function (result) {
        if (stale() || ended) { cancel(); return; }
        if (result.done) {
          buf += decoder.decode(); consume(true);
          if (!ended) finishStream(st);
          try { reader.releaseLock(); } catch (eLock) { /* ignore */ }
          return;
        }
        receivedAt = now();
        buf += decoder.decode(result.value, {stream: true});
        consume(false);
        if (stale() || ended) { cancel(); return; }
        pump();
      }).catch(function (error) {
        if (stale() || ended) return;
        finishAbnormal(st, String(error && (error.message || error.name) || "read error"), "read_error");
        try { reader.releaseLock(); } catch (eLock) { /* ignore */ }
      });
    }
    pump();
  }

  // 正常收尾（流读到 done）。v1.8.0：若期间挂起过 error 帧，按异常收尾
  function finishStream(st) {
    if (!st || !st.active) return;
    if (st.userStopped) { finishAbnormal(st, "", "user_stop"); return; }
    if (st.pendingError) { finishAbnormal(st, st.pendingError, "error_frame"); return; }
    endTurn(DONE, st, "", "stream_end");
  }

  // v1.8.0 异常收尾统一入口：有输出 → "已中断"；零输出 → 才叫"出错"
  // v1.9.0：页面刷新/关闭（pagehide 已触发）造成的零输出中止 → 也算"已中断（页面刷新）"，
  // 且不落库、不覆盖该会话上一条结果——那是导航掐死流，不是真失败
  function finishAbnormal(st, msg, cause) {
    if (!st || !st.active) return;
    var hasOutput = !!(st.tFirst || st.tokenCount > 0 || st.estimatedTokens > 0
      || st.charCount > 0 || st.toolTokens > 0 || (st.replayTokens || 0) > 0);
    if (!st.userStopped && st.__sid !== getSessionId()) {
      // QwenPaw aborts the viewing connection on route changes, while the agent
      // keeps generating. Keep in-memory observation for a later reconnect;
      // never overwrite the last completed result with a fictitious model abort.
      st.active = false; st.suspended = true; st.lastSpeed = 0;
      return;
    }
    var navAbort = pageLeaving && !hasOutput;
    var status = (st.userStopped || hasOutput || navAbort) ? "abort" : "error";
    var c = st.userStopped ? "user_stop" : (navAbort ? "page_refresh" : (cause || "read_error"));
    endTurn(status, st, msg, c);
  }

  // A run can finish while its viewing stream is disconnected. QwenPaw embeds
  // the final turn_usage in chat history metadata. Restore totals only; historical
  // text cannot establish decode timing, peaks, pauses or segment measurements.
  function hydrateChatHistory(sid, data) {
    if (!data || !Array.isArray(data.messages)) return;
    var state = states[sid];
    if (state && state.active) return;
    if (/running|in_progress|pending|generating/i.test(String(data.status || ""))) return;
    var messages = data.messages, lastUser = -1;
    for (var i = 0; i < messages.length; i++) if (messages[i].role === "user") lastUser = i;
    var message = null, usage = null;
    for (var j = messages.length - 1; j > lastUser; j--) {
      var candidate = messages[j];
      if (candidate.role !== "assistant") continue;
      var metadata = candidate.metadata || {};
      var nested = metadata.metadata || {};
      var snapshot = nested.qwenpaw_turn_usage || metadata.qwenpaw_turn_usage;
      if (!snapshot || !snapshot.usage) continue;
      usage = extractUsage({type: "turn_usage", usage: snapshot.usage});
      if (usage) { message = candidate; break; }
    }
    if (!message || !usage) return;
    if (state) state.suspended = false;
    var previous = loadLastResult(sid);
    var meta = message.metadata || {};
    var end = Date.parse(meta.finished_at || meta.timestamp || "");
    // The history adapter regenerates display message IDs on every fetch. Use
    // the stable backend turn key or exact counts plus the backend finish time.
    var turnKey = meta.original_id || message.id;
    var sameMeasuredTurn = previous && !previous.historyOnly && previous.outputTokens === usage.generated
      && previous.total === usage.total && (previous.turnKey === turnKey || Math.abs(previous.ts - end) < 2000);
    if (sameMeasuredTurn) {
      previous.turnKey = turnKey;
      saveLastResult(sid, previous);
      return;
    }
    var startMeta = lastUser >= 0 ? messages[lastUser].metadata || {} : {};
    var start = Date.parse(startMeta.timestamp || "");
    if (previous && previous.messageId && end && previous.ts > end + 2000) return;
    var channel = currentChannel(usage.provider);
    var money = moneyFields(channel.channel, usage.model, usage.promptTokens, usage.generated, usage.cacheHit);
    var turnState = startMeta.metadata && startMeta.metadata.qwenpaw_turn_state;
    var aborted = /abort|cancel|stop/i.test(String(turnState && turnState.status || ""));
    var result = {
      ts: isFinite(end) ? end : Date.now(), messageId: message.id, turnKey: turnKey, historyOnly: true,
      tokenSource: "usage", outputTokens: usage.generated, tokens: usage.generated, toolTokens: 0,
      total: usage.total, promptTokens: usage.promptTokens, costTokens: usage.generated,
      cacheHit: usage.cacheHit, cacheMiss: Math.max(0, usage.promptTokens - usage.cacheHit),
      model: usage.model, provider: usage.provider, channel: channel.channel, channelSrc: "usage",
      cost: money.cost, costUnit: money.costUnit, afp: money.afp, coefMissing: money.coefMissing, priceMissing: money.priceMissing,
      aliasModel: money.aliasModel, coefRange: money.coefRange, afpLo: money.afpLo, afpHi: money.afpHi,
      status: aborted ? "abort" : DONE, endCause: aborted ? "user_stop" : "history", errMsg: "",
      ttft: 0, seconds: isFinite(start) && isFinite(end) && end >= start ? (end - start) / 1000 : 0,
      secondsKnown: isFinite(start) && isFinite(end) && end >= start,
      genTime: 0, genSpeed: 0, avg: 0, peak: 0, pauseSec: 0, segments: [],
      attached: false, replayTokens: 0, totalGenerated: usage.generated, liveTokens: 0
    };
    saveLastResult(sid, result);
    if (sid === getSessionId()) { refreshBarContent(); refreshDetail(result); }
  }

  // v1.8.0：渠道证据是异步到的（/api/models/active、/api/models）。证据到手后把
  // 正在跑的回合与"当前会话最后一条结果"就地重算一遍金额，避免用户看到空着或写错的
  // 金额（v1.7 老结果没有 channelSrc，rank=0，会被更强证据修正掉——用户这次看到的
  // 错金额就属于这一类）
  function channelRank(src) {
    if (src === "usage") return 3;
    if (src === "active") return 2;
    if (src === "model" || src === "memory") return 1;
    return 0;
  }
  function applyBillingRetro(force) {
    try {
      var cur = currentChannel(""); // 当前配置证据（单回合的 usage 证据只有该回合自己有）
      Object.keys(states).forEach(function (sid) {
        var st = states[sid];
        if (!st || !st.active) return;
        var c = st.providerUsage ? currentChannel(st.providerUsage) : cur;
        if (c.channel && (force || channelRank(c.src) >= channelRank(st.channelSrc))) {
          st.channel = c.channel;
          st.channelSrc = c.src;
          st.provider = c.provider || st.provider;
        }
      });
      var sid2 = getSessionId();
      var r = loadLastResult(sid2);
      if (!r || typeof r !== "object") return;
      // Re-price a known historical provider using that provider's own evidence.
      // A current settings change must not turn an unrelated vendor into AFP or
      // DeepSeek just because the historical channel was previously unknown.
      if (r.provider) {
        cur = {channel: resolveChannel(r.provider, providerBaseUrl(r.provider)), provider: r.provider,
          src: r.channelSrc === "usage" ? "usage" : "memory"};
      }
      if (!cur.channel) return;
      var stronger = channelRank(cur.src) > channelRank(r.channelSrc);
      // force：providerMap（base_url 证据）刚到位时允许升级，但只允许从"其他渠道/未识别"
      // 升上来（评审 P1-5 证据击穿：旧版 force 能覆盖任何渠道，切渠道后会把 usage 实证过
      // 的历史结果重算一遍，金额被凭空改写）
      var upgraded = !!force && (!r.channel || r.channel === "other") && cur.channel !== r.channel;
      if (!stronger && !upgraded) return;
      var pt = r.promptTokens != null ? r.promptTokens : ((r.cacheHit || 0) + (r.cacheMiss || 0));
      var ct = r.costTokens != null ? r.costTokens : r.tokens;
      var money = moneyFields(cur.channel, r.model, pt, ct, r.cacheHit || 0);
      var before = [r.cost == null ? "n" : r.cost, r.afp == null ? "n" : r.afp, r.channel || "",
        r.afpLo == null ? "n" : r.afpLo, r.afpHi == null ? "n" : r.afpHi].join("|");
      var after = [money.cost == null ? "n" : money.cost, money.afp == null ? "n" : money.afp, money.channel,
        money.afpLo == null ? "n" : money.afpLo, money.afpHi == null ? "n" : money.afpHi].join("|");
      if (before === after) return;
      r.cost = money.cost;
      r.afp = money.afp;
      r.channel = money.channel;
      r.channelSrc = cur.src;
      r.provider = cur.provider || r.provider;
      r.coefMissing = money.coefMissing;
      r.priceMissing = money.priceMissing;
      r.aliasModel = money.aliasModel;
      r.afpLo = money.afpLo;
      r.afpHi = money.afpHi;
      r.costUnit = money.costUnit;
      r.coefRange = money.coefRange;
      saveLastResult(sid2, r);
      refreshBarContent();
      refreshDetail(r);
    } catch (e) { /* 金额补算失败不影响统计 */ }
  }
