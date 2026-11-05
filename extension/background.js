// 视频讲解器 · background service worker
// 职责：① 注册「点图标开侧边栏」行为；② 跨域资源中转（aisubtitle.hdslb.com 等不允许
// 页面直接跨域拉的域名 —— 扩展后台带 host_permissions + 登录 Cookie，无 CORS 限制）。
// 注意：不要监听 action.onClicked——openPanelOnActionClick 已把图标点击
// 变成开/关面板的切换，再调 sidePanel.open 会导致面板关不上。
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// 跨域 GET 中转
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.cmd !== 'VJX_FETCH_URL') return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  fetch(msg.url, { credentials: 'include', signal: ctrl.signal })
    .then(async (res) => {
      clearTimeout(timer);
      const body = await res.text();
      sendResponse({ ok: res.ok, status: res.status, body });
    })
    .catch((e) => {
      clearTimeout(timer);
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    });
  return true; // 异步
});

