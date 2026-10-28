import type { ServerResponse } from "node:http";

const responseHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const pageCsp = "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'";

function renderPage(res: ServerResponse, page: "login" | "account") {
  res.writeHead(200, {
    ...responseHeaders,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": pageCsp,
  });
  res.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi · ${page === "account" ? "账户设置" : "本地登录"}</title>
<style>
:root{color-scheme:light;--ink:#192b30;--muted:#52666b;--line:#dce5e3;--accent:#146557;--soft:#eef6f2;--warn:#8b5117;--danger:#9d3530}*{box-sizing:border-box}body{margin:0;background:#f5f7f4;color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}main{width:min(100%,460px);margin:auto;padding:28px 18px 44px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px}.mark{display:grid;place-items:center;width:44px;height:44px;border-radius:14px;background:var(--accent);color:#fff;font-weight:750}.eyebrow{margin:0;color:var(--muted);font-size:13px;letter-spacing:.08em}h1{font-size:25px;line-height:1.3;margin:0}h2{font-size:19px;margin:0 0 8px}p{margin:10px 0}.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:24px;box-shadow:0 5px 20px #182d2610}.intro,.help,.identity{color:var(--muted)}.identity{overflow-wrap:anywhere}.notice{min-height:24px;color:var(--warn);white-space:pre-wrap}.error{min-height:24px;color:var(--danger);font-size:14px;white-space:pre-wrap}label{display:block;margin:16px 0 6px;color:var(--muted);font-size:14px}input,button{width:100%;min-height:44px;border:1px solid #c8d7d2;border-radius:10px;padding:9px 12px;background:#fff;color:var(--ink);font:inherit}input:focus-visible,button:focus-visible{outline:3px solid #68aa98;outline-offset:3px}button{cursor:pointer;font-weight:650}button:hover:not(:disabled){background:var(--soft);border-color:var(--accent)}button:disabled,input:disabled{opacity:.55;cursor:default}.primary{margin-top:18px;background:var(--accent);border-color:var(--accent);color:#fff}.primary:hover:not(:disabled){background:#0b5145}.secondary{margin-top:12px}.danger{margin-top:12px;color:var(--danger)}.divider{border:0;border-top:1px solid var(--line);margin:24px 0}.footer{margin:20px 2px 0;color:var(--muted);font-size:13px}[hidden]{display:none!important}@media(max-width:420px){main{padding:20px 14px 34px}.card{padding:20px}h1{font-size:22px}}@media(prefers-reduced-motion:no-preference){button,input{transition:border-color .15s,background .15s}}
</style></head>
<body data-auth-page="${page}"><main>
<header class="brand"><span class="mark" aria-hidden="true">Pi</span><div><p class="eyebrow">LOCAL HUB</p><h1>${page === "account" ? "账户设置" : "本地登录"}</h1></div></header>
${page === "account" ? accountMarkup : loginMarkup}
<noscript><p class="notice">请启用 JavaScript 后继续。</p></noscript>
</main><script src="/auth.js" defer></script></body></html>`);
}

const loginMarkup = `<section class="card" aria-labelledby="auth-title">
<h2 id="auth-title">正在检查登录状态…</h2><p id="auth-intro" class="intro">请稍候。</p><p id="auth-notice" class="notice" role="status" aria-live="polite"></p>
<form id="auth-form" novalidate><label for="auth-username">用户名</label><input id="auth-username" name="username" type="text" autocomplete="username" maxlength="64" required>
<label for="auth-password">密码</label><input id="auth-password" name="password" type="password" autocomplete="current-password" minlength="12" maxlength="256" required>
<button id="auth-submit" class="primary" type="submit" disabled>登录</button></form>
<p id="auth-error" class="error" role="alert" aria-live="assertive"></p><p class="footer">远程访问请使用 HTTPS。密码不会写入浏览器存储；登录由 HttpOnly Cookie 维持，不使用 localStorage。</p>
</section>`;

const accountMarkup = `<section class="card" aria-labelledby="auth-title">
<h2 id="auth-title">正在检查会话…</h2><p class="identity">当前用户名：<strong id="auth-current-username">—</strong></p><p id="auth-notice" class="notice" role="status" aria-live="polite"></p>
<form id="auth-form" novalidate hidden><label for="auth-username">用户名</label><input id="auth-username" name="username" type="text" autocomplete="username" maxlength="64" required>
<label for="auth-current-password">当前密码</label><input id="auth-current-password" name="current-password" type="password" autocomplete="current-password" minlength="12" maxlength="256" required>
<label for="auth-password">新密码</label><input id="auth-password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="256" required>
<button id="auth-submit" class="primary" type="submit" disabled>保存并重新登录</button></form>
<p id="auth-error" class="error" role="alert" aria-live="assertive"></p><hr class="divider"><button id="auth-logout" class="secondary" type="button" disabled>退出当前设备</button><button id="auth-logout-all" class="danger" type="button" disabled>退出所有设备</button>
</section>`;

/** Serves the login/setup page. State determines whether bootstrap setup is permitted. */
export function renderAuthPage(res: ServerResponse): void {
  renderPage(res, "login");
}

/** Serves the account page. The authenticated username is fetched client-side, never embedded in markup. */
export function renderAccountPage(res: ServerResponse): void {
  renderPage(res, "account");
}

/** Serves the shared, external browser logic for the auth and account pages. */
export function renderAuthScript(res: ServerResponse): void {
  res.writeHead(200, { ...responseHeaders, "Content-Type": "text/javascript; charset=utf-8" });
  res.end(authScript);
}

const authScript = String.raw`"use strict";
(() => {
  const el = id => document.getElementById(id);
  const page = document.body && document.body.dataset.authPage;
  let csrf = '', ready = false, submitting = false, setupMode = false;
  const genericError = '操作未完成，请检查输入后重试。';
  const stateError = '无法确认登录状态，请检查本机服务后重试。';
  const text = (id, value) => { el(id).textContent = value; };
  const hasText = value => typeof value === 'string' && value.trim() !== '';
  const validState = value => value && typeof value.authenticated === 'boolean' &&
    typeof value.setupRequired === 'boolean' && typeof value.setupAllowed === 'boolean' &&
    hasText(value.csrfToken) && (value.username === undefined || typeof value.username === 'string');
  function controls() {
    const disabled = !ready || submitting;
    for (const id of ['auth-username', 'auth-password', 'auth-current-password', 'auth-submit', 'auth-logout', 'auth-logout-all']) {
      const node = el(id); if (node) node.disabled = disabled;
    }
  }
  function error(message) { text('auth-error', message); }
  function passwordValid(value) { return typeof value === 'string' && value.length >= 12 && value.length <= 256; }
  async function request(route, body, timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const options = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal };
      if (body !== undefined) {
        if (!csrf) throw Error('CSRF unavailable');
        options.headers = { 'Content-Type': 'application/json', 'X-Pi-Local-Csrf': csrf };
        options.body = JSON.stringify(body);
      }
      const response = await fetch(route, options);
      let value = null;
      try { value = await response.json(); } catch (_) { value = null; }
      if (!response.ok) { const failure = Error('request failed'); failure.status = response.status; throw failure; }
      return value;
    } finally { clearTimeout(timer); }
  }
  function showLogin(state) {
    if (state.authenticated) { location.replace('/'); return; }
    const form = el('auth-form');
    setupMode = false;
    if (state.setupRequired) {
      if (!state.setupAllowed) {
        text('auth-title', '需要本机初始化');
        text('auth-intro', '此服务尚未完成首次初始化。');
        text('auth-notice', '首次创建账户只能在部署主机的本机终端完成。请使用本地重置或初始化流程后，再返回此页登录；此处不提供公开注册。');
        form.hidden = true;
        return;
      }
      setupMode = true;
      text('auth-title', '本机初始化');
      text('auth-intro', '首次账户只允许通过本机服务创建。请设置管理员用户名和密码。');
      text('auth-submit', '创建账户并进入');
      el('auth-password').setAttribute('autocomplete', 'new-password');
      return;
    }
    text('auth-title', '登录 Pi');
    text('auth-intro', '使用您的本机账户继续。');
    text('auth-submit', '登录');
  }
  function showAccount(state) {
    if (!state.authenticated || !hasText(state.username)) { location.replace('/login'); return; }
    text('auth-title', '账户设置');
    text('auth-current-username', state.username);
    el('auth-username').value = state.username;
    el('auth-form').hidden = false;
  }
  async function submit(event) {
    event.preventDefault();
    if (!ready || submitting || (page !== 'login' && page !== 'account')) return;
    const username = el('auth-username').value.trim();
    const password = el('auth-password').value;
    error('');
    if (!username || username.length > 64 || !passwordValid(password)) {
      error('请输入用户名，以及 12 到 256 个字符的密码。'); return;
    }
    let route, body, redirect;
    if (page === 'account') {
      const currentPassword = el('auth-current-password').value;
      if (!passwordValid(currentPassword)) { error('请输入当前密码，以及 12 到 256 个字符的新密码。'); return; }
      route = '/api/auth/password'; body = { currentPassword, username, password }; redirect = '/login';
    } else {
      route = setupMode ? '/api/auth/setup' : '/api/auth/login'; body = { username, password }; redirect = '/';
    }
    submitting = true; controls();
    try { await request(route, body, 30000); location.replace(redirect); }
    catch (_) { error(genericError); }
    finally { submitting = false; controls(); }
  }
  async function logout(route) {
    if (!ready || submitting) return;
    error(''); submitting = true; controls();
    try { await request(route, {}, 30000); location.replace('/login'); }
    catch (_) { error(genericError); }
    finally { submitting = false; controls(); }
  }
  async function start() {
    controls();
    try {
      const state = await request('/api/auth/state', undefined, 10000);
      if (!validState(state)) throw Error('invalid state');
      csrf = state.csrfToken;
      if (page === 'login') showLogin(state); else if (page === 'account') showAccount(state); else throw Error('unknown page');
      ready = true; controls();
    } catch (_) { error(stateError); }
  }
  el('auth-form').addEventListener('submit', submit);
  const logoutButton = el('auth-logout');
  const logoutAllButton = el('auth-logout-all');
  if (logoutButton) logoutButton.addEventListener('click', () => logout('/api/auth/logout'));
  if (logoutAllButton) logoutAllButton.addEventListener('click', () => logout('/api/auth/logout-all'));
  start();
})();`;
