// 会话 ID：从 URL 提取（/chat/<uuid>）。大小写不敏感（评审 P1-3）。
export function getSessionId() {
  var m = location.pathname.match(/\/chat\/([^/?#]+)/i);
  if (!m) return "default";
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}