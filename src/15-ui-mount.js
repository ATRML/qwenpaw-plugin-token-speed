  // ════════════════════════════════════════════════════════════
  // 15-ui-mount.js · 挂载与定位（fixed 脱离 React 树）/ 标语隐藏 / 会话切换
  // ════════════════════════════════════════════════════════════
  // ---------- 位置与挂载（fixed，脱离 React 树） ----------

  function isOnChatPage() {
    return !!(document.querySelector(
      ".qwenpaw-chat-anywhere-input, [class*='chat-anywhere-input'], " +
      ".qwenpaw-chat-anywhere-message-list, .qwenpaw-bubble-list-scroll"
    ));
  }

  function positionBar() {
    var bar = document.getElementById(BAR_ID);
    if (!bar) return;
    if (!isOnChatPage()) { bar.style.display = "none"; return; }
    bar.style.display = "flex";
    var inputBox = document.querySelector(".qwenpaw-chat-anywhere-input, [class*='chat-anywhere-input']");
    if (inputBox) {
      var rect = inputBox.getBoundingClientRect();
      if (rect && rect.height > 0 && rect.top > 0) {
        bar.style.bottom = Math.max(64, window.innerHeight - rect.top + 6) + "px";
        // 水平中心 = 输入框容器中心（不是视口中心：右侧挂边栏时视口居中会偏）
        var cx = rect.left + rect.width / 2;
        var half = bar.offsetWidth / 2;
        if (half > 0) cx = Math.max(half + 4, Math.min(cx, window.innerWidth - half - 4)); // 防极端出视口
        bar.style.left = cx + "px";
        bar.style.transform = "translateX(-50%)";
        return;
      }
    }
    // v1.5.0：聊天页上锚点丢失不再静默（旧版 QwenPaw 改版时 bar 位置会悄悄回退默认）
    warnOnce("anchor", "聊天页上找不到输入框容器（.qwenpaw-chat-anywhere-input），悬浮条位置回退默认——QwenPaw 前端可能已改版");
    bar.style.bottom = "96px";
    bar.style.left = "50%";
    bar.style.transform = "translateX(-50%)";
  }

  // v1.13.0（评审 P0-3）：扫 body 时排除聊天气泡/消息正文与本插件自己的 DOM——
  // 标语是"页面上的独立小节点"，而用户消息里出现"懂你所需/伴你左右"时它的父节点
  // 也可能是个 <30 字的短元素，旧版会把用户气泡整块 display:none（实测未触发，属预防）
  function insideChatOrPlugin(el) {
    try {
      for (var p = el, i = 0; p && i < 8; i++, p = p.parentElement) {
        if (p.id === BAR_ID || p.id === PANEL_ID) return true;
        var cls = (typeof p.className === "string") ? p.className : "";
        if (!cls) continue;
        if (cls.indexOf("qp-") >= 0) return true;
        if (/(bubble|markdown|message|prose|chat-|assistant|user-)/i.test(cls)) return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function hideAnchor() {
    try {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var t = n.textContent || "";
          return (t.indexOf("懂你所需") >= 0 || t.indexOf("伴你左右") >= 0)
            ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var n;
      while ((n = walker.nextNode())) {
        var el = n.parentElement;
        if (el && !el._qpHidden && !insideChatOrPlugin(el)) {
          var flat = (el.textContent || "").replace(/\s+/g, "");
          if (flat.length < 30) {
            el.style.display = "none";
            el._qpHidden = true;
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  function refreshBarContent() {
    var bar = document.getElementById(BAR_ID);
    if (!bar) { injectBar(); return; }
    var sid = getSessionId();
    var activeSt = getActiveStream(sid);
    if (activeSt) {
      bar.className = "running";
      // v1.7.0：走统一视图（旧版这里写死 speed:0 且丢 attached/replay 标记，
      // 切到正在生成中的会话时悬浮条会显示错误口径）
      bar.innerHTML = !activeSt.tFirst && !activeSt.attached ? buildWaitingHtml() : buildRunningHtml(runningView(activeSt));
    } else {
      if (states[sid] && states[sid].suspended) {
        bar.className = "running";
        bar.innerHTML = '<span class="qp-ts-dot"></span><span>正在重新接入后台生成…</span>';
        positionBar();
        return;
      }
      var r = loadLastResult(sid);
      if (r) {
        bar.className = r.status === DONE ? "done" : r.status;
        bar.innerHTML = buildResultHtml(r);
      } else {
        bar.className = "";
        bar.innerHTML = '<span class="qp-ts-dot"></span><span>暂无数据，发一条消息试试</span>';
      }
    }
    positionBar();
  }

  function injectBar() {
    if (document.getElementById(BAR_ID)) return true;
    var bar = document.createElement("div");
    bar.id = BAR_ID;
    bar.title = "点击查看本轮速度、用量和耗时";
    bar.setAttribute("role", "button");
    bar.setAttribute("tabindex", "0");
    bar.setAttribute("aria-label", "查看本轮生成详情");
    bar.addEventListener("keydown", function(e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onBarClick(e); } });
    bar.addEventListener("click", onBarClick);
    document.body.appendChild(bar);
    refreshBarContent();
    hideAnchor();
    return true;
  }

  function installRouteTracking() {
    if (!window.history) return;
    var visibleSid = getSessionId();
    function changed() {
      var sid = getSessionId();
      if (sid === visibleSid) return;
      visibleSid = sid;
      closeDetail();
      refreshBarContent();
    }
    ["pushState", "replaceState"].forEach(function (name) {
      var original = window.history[name];
      if (typeof original !== "function") return;
      window.history[name] = function () {
        var result = original.apply(this, arguments);
        try { changed(); } catch (eRoute) { /* never interfere with navigation */ }
        return result;
      };
    });
    window.addEventListener("popstate", changed);
  }
