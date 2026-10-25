import { HUB_GENERATION_SOURCE } from "../protocol/hub-generation.ts";

/** Static trusted shell. Serve only on the management listener, never through Pi. */
export function renderInteractionPageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Pi · 可信交互审核</title>
<link rel="stylesheet" href="/interaction-page.css"><script src="/interaction-page.js" defer></script></head>
<body><main><header><span class="brand">π · Pi Web</span><span class="badge">可信管理页面</span></header>
<h1>审核原始操作</h1><p>请核对来源、范围和全部预览后明确决定。登录不等于批准；授权送达也不代表操作已经执行成功。</p>
<p id="review-status" role="status" aria-live="polite">正在读取管理状态…</p>
<p id="review-outcome" role="status" aria-live="polite"></p>
<section aria-labelledby="management-title"><h2 id="management-title">管理身份</h2>
<p id="management-help">复用现有管理登录，不创建新密码。</p>
<button id="management-gateway" type="button" hidden disabled>使用网页登录解锁</button>
<form id="management-unlock" hidden autocomplete="off"><label for="management-code">既有一次性管理码</label>
<input id="management-code" type="password" autocomplete="off" spellcheck="false" maxlength="32" required disabled>
<button id="management-submit" type="submit" disabled>解锁管理</button></form></section>
<p id="review-notice" role="status" aria-live="polite"></p>
<section aria-labelledby="preview-title"><h2 id="preview-title">完整操作预览</h2>
<pre id="review-preview" tabindex="0"></pre>
<h3>完整请求（含来源、范围、期限和绑定摘要）</h3><pre id="review-request" tabindex="0"></pre>
<h3>允许的回答格式</h3><pre id="review-schema" tabindex="0"></pre></section>
<section id="review-oauth" hidden aria-labelledby="oauth-title"><h2 id="oauth-title">提供方登录</h2>
<p>请检查下面的真实 HTTPS 地址。只有点击按钮才会打开提供方；本页不会代替你同意提供方授权。若手机流程不受支持，请使用原终端流程。</p>
<p id="review-oauth-url" class="identity"></p><button id="review-oauth-open" type="button" disabled>打开提供方登录 ↗</button></section>
<section aria-labelledby="decision-title"><h2 id="decision-title">你的决定</h2>
<div id="review-confirm" class="actions" hidden><button id="review-reject" type="button" disabled>拒绝此操作</button><button id="review-allow" type="button" disabled>允许此操作</button></div>
<form id="review-answer-form" hidden autocomplete="off"><label id="review-answer-label" for="review-text">回答</label>
<select id="review-options" aria-label="明确选择一个源操作选项" hidden disabled></select>
<textarea id="review-text" rows="5" autocomplete="off" autocapitalize="off" spellcheck="false" hidden disabled></textarea>
<button id="review-answer-submit" type="submit" disabled>提交此回答</button></form>
<p id="review-decision" class="identity"></p><div class="actions"><button id="review-refresh" type="button" disabled>查询当前状态（不重新提交）</button>
<button id="review-cancel" type="button">结束本页审核（不提交）</button></div></section>
<footer>内容与输入仅保留在本页内存中。网络结果不明时只查询原请求，不创建新决定；请先核对源操作，勿通过重开页面重复批准。</footer>
</main></body></html>`;
}

/** No backend text enters markup, navigation, storage, logs, or an opener. */
export const interactionPageJs = String.raw`(() => {
  'use strict';
  const get = (id) => document.getElementById(id);
  const encoder = new TextEncoder();
  const route = new RegExp('^/interactions/(${HUB_GENERATION_SOURCE})/([a-f0-9]{32})/$').exec(window.location.pathname);
  const labels = {
    pending: '等待你的明确决定；尚未授权。', delivering: '正在核对并送达决定，尚无执行结果。',
    allowed: '授权已送达；不代表源操作执行成功，请查看源操作的独立结果。',
    rejected: '决定已拒绝；本页不声称源操作已执行。', cancelled: '请求已取消；不能从本页继续授权。',
    expired: '请求已过期；不能再批准。', stale: '请求或身份已变化，旧审核已失效；请回到源操作检查。',
    delivery_unknown: '决定送达结果不明；仅查询原请求，不会重新提交。请核对源操作后再发起新操作。',
  };
  const terminal = (value) => ['allowed', 'rejected', 'cancelled', 'expired', 'stale'].includes(value);
  const hex = (value, length) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + length + '}$').test(value);
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const label = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
  const exact = (value, required, optional = []) => record(value) && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
  const stable = (value) => JSON.stringify(value, function(_key, item) {
    if (!record(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
  const fail = (status = 0) => Object.assign(new Error('Review unavailable'), { status });
  let auth = { authorized: false };
  let request, fingerprint, oauthUrl, decision;
  let state = 'loading', deadline = 0, working = false, closed = false, epoch = 0, fatal = false, readOnly = false;
  let pollTimer, expiryTimer;
  const api = route ? '/api/management/interactions/' + route[1] + '/' + route[2] : '';
  const notice = (text) => { get('review-notice').textContent = text; };
  function clearTimers() { clearTimeout(pollTimer); clearTimeout(expiryTimer); pollTimer = expiryTimer = undefined; }
  function clearPrivate() {
    request = undefined; oauthUrl = undefined;
    for (const id of ['review-preview', 'review-request', 'review-schema', 'review-oauth-url', 'review-outcome']) get(id).textContent = '';
    get('review-options').replaceChildren(); get('review-options').value = '';
    get('review-text').value = ''; get('management-code').value = '';
  }
  function eligible() {
    return !closed && !fatal && !readOnly && !working && !decision && auth.authorized && state === 'pending' && request && deadline > Date.now();
  }
  function paint() {
    const enabled = !!eligible();
    for (const id of ['review-allow', 'review-reject', 'review-options', 'review-text', 'review-answer-submit']) get(id).disabled = !enabled;
    get('review-oauth-open').disabled = !enabled || !oauthUrl;
    get('review-refresh').disabled = working;
    get('review-cancel').disabled = working || closed;
    const locked = !auth.authorized && !closed && !fatal;
    get('management-gateway').hidden = !locked || auth.authMode !== 'gateway';
    get('management-unlock').hidden = !locked || auth.authMode === 'gateway';
    for (const id of ['management-gateway', 'management-code', 'management-submit']) get(id).disabled = !locked || working;
    get('management-help').textContent = auth.authorized ? '管理已解锁；登录没有批准此操作。' :
      auth.authMode === 'gateway' ? '请使用已验证的网页登录身份解锁；若登录已失效，请重新登录管理入口。' : '复用既有一次性管理码；请向管理员获取，不创建新密码。';
    get('review-confirm').hidden = request?.schema.kind !== 'confirm';
    get('review-answer-form').hidden = !request || request.schema.kind === 'confirm';
    get('review-options').hidden = request?.schema.kind !== 'select';
    get('review-text').hidden = request?.schema.kind !== 'text';
    get('review-oauth').hidden = request?.purpose !== 'oauth';
    get('review-status').textContent = labels[state] || (state === 'closed' ? '本页审核已结束；未提交新决定。原操作是否仍待处理，请在源端核对。' :
      state === 'locked' ? '管理未解锁；尚未读取或批准操作。' : '正在读取管理状态…');
    get('review-decision').textContent = decision ? '原决定编号：' + decision.id + '（本页不会另建或重发决定）' : '';
  }
  function settle(next) {
    state = next;
    if (terminal(next)) { readOnly = true; clearTimers(); clearPrivate(); }
    paint();
  }
  function receipt(value) {
    if (!exact(value, ['state'], ['outcome']) || !Object.hasOwn(labels, value.state) ||
        (value.outcome !== undefined && (value.state !== 'allowed' || !['succeeded', 'failed', 'cancelled'].includes(value.outcome)))) throw fail();
    // Hub has already discarded sensitive bodies. A completion is a read-only
    // observation of this fixed request, never another actionable preview.
    readOnly = true;
    clearPrivate();
    settle(value.state);
    const outcomes = { succeeded: '源操作报告：已执行成功。', failed: '源操作报告：执行失败。', cancelled: '源操作报告：执行已取消。' };
    get('review-outcome').textContent = value.outcome ? outcomes[value.outcome] : value.state === 'allowed' ? '源操作尚未报告执行结果。' : '';
  }
  function schedule() {
    clearTimers();
    if (closed || fatal || terminal(state) || !auth.authorized || !deadline) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      clearPrivate(); state = decision ? 'delivery_unknown' : 'expired'; paint(); return;
    }
    expiryTimer = setTimeout(() => {
      clearTimers(); clearPrivate(); state = decision ? 'delivery_unknown' : 'expired'; paint();
    }, remaining);
    if (!document.hidden && !working) pollTimer = setTimeout(() => { void refresh(); }, Math.min(2000, remaining));
  }
  async function call(path, body) {
    const before = epoch;
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', mode: 'same-origin', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(7000),
      headers: { 'Content-Type': 'application/json', ...(auth.authorized ? { 'X-Pi-Hub-Csrf': auth.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (closed || before !== epoch) { await response.body?.cancel(); throw fail(); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) { auth = { ...auth, authorized: false }; clearPrivate(); }
      throw fail(response.status);
    }
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') { await response.body?.cancel(); throw fail(); }
    // Do not turn a truncated preview into an actionable review.
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536 || closed || before !== epoch) throw fail();
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    if (closed || before !== epoch) throw fail();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  async function checkAuth() {
    const value = await call('/api/management/status');
    if (!record(value) || typeof value.authorized !== 'boolean') throw fail();
    auth = { authorized: value.authorized, authMode: value.authMode === 'gateway' ? 'gateway' : 'code' };
    if (value.authorized) {
      if (!hex(value.csrf, 64) || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) { auth.authorized = false; clearPrivate(); throw fail(401); }
      auth.csrf = value.csrf;
    } else { clearPrivate(); if (!decision) state = 'locked'; }
    return auth.authorized;
  }
  function checked(value) {
    const keys = ['protocol', 'schemaVersion', 'requestId', 'operationId', 'identity', 'adapter', 'createdAt', 'digest', 'action', 'revision', 'classification', 'method', 'schema', 'content', 'deadline'];
    if (!exact(value, keys, ['purpose', 'state']) || value.protocol !== 'pi-web-interactions-v1' || value.schemaVersion !== 1 ||
        value.requestId !== route[2] || !hex(value.operationId, 32) || !hex(value.digest, 64) ||
        !exact(value.identity, ['runId', 'generation', 'runtimeId', 'sessionId']) || value.identity.generation !== route[1] || !hex(value.identity.runId, 32) ||
        !label(value.identity.runtimeId) || !label(value.identity.sessionId) || !exact(value.adapter, ['id', 'version', 'packageName']) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(value.adapter.id) || !label(value.adapter.version, 64) || !label(value.adapter.packageName, 128) ||
        value.classification !== 'sensitive' || !label(value.action, 64) || !/^[a-z][a-z0-9_.-]*$/.test(value.action) || !label(value.revision) ||
        !record(value.content) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Number.isSafeInteger(value.deadline) || value.deadline <= value.createdAt ||
        value.deadline - value.createdAt > (value.purpose === 'oauth' ? 600000 : 120000) || (value.purpose !== undefined && value.purpose !== 'oauth') ||
        (value.state !== undefined && !Object.hasOwn(labels, value.state))) throw fail();
    const schema = value.schema;
    if (!record(schema)) throw fail();
    if (schema.kind === 'confirm') { if (value.method !== 'confirm' || !exact(schema, ['kind'])) throw fail(); }
    else if (schema.kind === 'select') {
      if (value.method !== 'select' || !exact(schema, ['kind', 'options']) || !Array.isArray(schema.options) || schema.options.length < 1 || schema.options.length > 100 ||
          schema.options.some((option) => !label(option, 512)) || new Set(schema.options).size !== schema.options.length) throw fail();
    } else if (schema.kind === 'text') {
      if (!['input', 'editor'].includes(value.method) || !exact(schema, ['kind', 'maxBytes']) || !Number.isSafeInteger(schema.maxBytes) || schema.maxBytes < 1 || schema.maxBytes > 32768) throw fail();
    } else throw fail();
    return value;
  }
  function providerUrl(value) {
    if (typeof value !== 'string' || !/^https:\/\//i.test(value) || /[\s\p{Cc}]/u.test(value)) return;
    try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch {}
  }
  function accept(value) {
    if (record(value) && !Object.hasOwn(value, 'protocol')) { receipt(value); return; }
    const live = checked(value);
    const { state: observed = 'pending', ...body } = live;
    if (terminal(observed)) { settle(observed); return; }
    if (readOnly) { settle('stale'); return; }
    if (deadline && live.deadline !== deadline || fingerprint && stable(body) !== fingerprint) { settle('stale'); return; }
    if (live.deadline <= Date.now()) { settle(decision ? 'delivery_unknown' : 'expired'); return; }
    deadline = live.deadline;
    if (decision) { state = 'delivery_unknown'; return; } // A live GET never proves a prior POST failed.
    state = observed;
    if (fingerprint && request) return; // Preserve drafts, but restore the view after reauthentication.
    fingerprint = stable(body); request = body;
    get('review-preview').textContent = typeof body.content.preview === 'string' ? body.content.preview : JSON.stringify(body.content, null, 2);
    get('review-request').textContent = JSON.stringify(body, null, 2);
    get('review-schema').textContent = JSON.stringify(body.schema, null, 2);
    if (body.schema.kind === 'select') {
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '请选择，不默认批准';
      get('review-options').replaceChildren(placeholder);
      for (const choice of body.schema.options) { const option = document.createElement('option'); option.value = choice; option.textContent = choice; get('review-options').append(option); }
      get('review-options').value = '';
    }
    get('review-answer-label').textContent = body.purpose === 'oauth' ? '粘贴此提供方流程的回调（仅本页内存，不自动打开回调）' : body.schema.kind === 'select' ? '选择源操作提供的选项' : '输入回答';
    if (body.purpose === 'oauth') {
      oauthUrl = providerUrl(body.content.authorizationUrl);
      get('review-oauth-url').textContent = typeof body.content.authorizationUrl === 'string' ? body.content.authorizationUrl : '未提供支持的 HTTPS 登录地址';
      if (!oauthUrl) notice('提供方登录链接不可用或不安全；请保留原终端流程，不会自动打开任何地址。');
    }
    get('review-preview').focus();
  }
  async function refresh(explicit = false) {
    if (closed || fatal || working || (!explicit && terminal(state))) return;
    working = true; clearTimers(); paint();
    try { if (await checkAuth()) accept(await call(api)); }
    catch (error) {
      if (!closed) {
        clearPrivate();
        state = decision ? 'delivery_unknown' : error.status === 401 ? 'locked' : 'stale';
        notice('无法读取完整且当前有效的请求；未重新提交决定。请检查管理登录与源操作。');
      }
    } finally { working = false; paint(); schedule(); }
  }
  async function unlock(gateway) {
    if (closed || fatal || working || auth.authorized || (auth.authMode === 'gateway') !== gateway) return;
    const code = get('management-code').value.trim(); get('management-code').value = '';
    if (!gateway && !hex(code, 32)) { notice('请输入既有的 32 位一次性管理码。'); return; }
    working = true; paint();
    try {
      await call('/api/management/' + (gateway ? 'gateway' : 'unlock'), gateway ? {} : { code });
      if (await checkAuth()) { notice('管理已解锁；尚未批准任何操作。'); accept(await call(api)); }
    } catch { if (!closed) { auth.authorized = false; clearPrivate(); state = decision ? 'delivery_unknown' : 'locked'; notice('管理登录或请求读取未完成，请核对既有登录入口；不会自动批准。'); } }
    finally { working = false; paint(); schedule(); }
  }
  async function decide(answer) {
    if (!eligible()) { if (deadline && deadline <= Date.now() && !decision) settle('expired'); return; }
    const original = request;
    const schema = original.schema;
    if (!(schema.kind === 'confirm' && typeof answer === 'boolean' || schema.kind === 'select' && schema.options.includes(answer) ||
          schema.kind === 'text' && typeof answer === 'string' && encoder.encode(answer).byteLength <= schema.maxBytes)) {
      notice('回答必须符合上方完整格式与 UTF-8 字节上限；请明确选择。'); return;
    }
    working = true; clearTimers();
    decision = { id: [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
    state = 'delivering'; get('review-text').value = ''; paint();
    try {
      if (!await checkAuth()) throw fail(401);
      const observation = await call(api);
      if (record(observation) && !Object.hasOwn(observation, 'protocol')) { receipt(observation); return; }
      const live = checked(observation);
      const { state: observed = 'pending', ...body } = live;
      if (observed !== 'pending') { settle(observed); return; }
      if (stable(body) !== fingerprint) { settle('stale'); return; }
      if (live.deadline <= Date.now()) { settle('expired'); return; }
      const response = await call(api, { decisionId: decision.id, digest: original.digest, revision: original.revision, answer });
      receipt(response);
    } catch { if (!closed) settle('delivery_unknown'); }
    finally { answer = undefined; working = false; get('review-text').value = ''; paint(); schedule(); }
  }
  get('management-gateway').addEventListener('click', () => unlock(true));
  get('management-unlock').addEventListener('submit', (event) => { event.preventDefault(); return unlock(false); });
  get('review-refresh').addEventListener('click', () => refresh(true));
  get('review-allow').addEventListener('click', () => decide(true));
  get('review-reject').addEventListener('click', () => decide(false));
  get('review-answer-form').addEventListener('submit', (event) => {
    event.preventDefault(); return decide(request?.schema.kind === 'select' ? get('review-options').value : get('review-text').value);
  });
  get('review-oauth-open').addEventListener('click', () => {
    if (!eligible() || !oauthUrl) return;
    window.open(oauthUrl, '_blank', 'noopener,noreferrer');
    notice('已请求打开提供方页面；如弹窗被阻止，请允许本管理页弹出后再次点击，或使用终端流程。此动作不是批准。');
  });
  get('review-cancel').addEventListener('click', () => {
    if (working) return;
    closed = true; epoch++; state = 'closed'; clearTimers(); clearPrivate(); paint();
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(pollTimer);
    if (!document.hidden) return refresh();
  });
  window.addEventListener('pagehide', () => { closed = true; epoch++; auth = { authorized: false }; clearTimers(); clearPrivate(); paint(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { fatal = true; settle('stale'); notice('旧页面已失效，请从源操作重新打开；不要重复批准结果不明的操作。'); } });
  if (!route || window.location.search || window.location.hash || window.top !== window.self) {
    fatal = true; state = 'stale'; notice('只允许顶层管理页与完整固定请求路径；不接受查询参数、回调片段或跳转地址。'); paint();
  } else { void refresh(); }
})();`;

export const interactionPageCss = `:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;color:#21382e;background:#f4f7f2}*{box-sizing:border-box}body{margin:0}main{max-width:880px;margin:auto;padding:32px 24px 48px}header,.actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header{justify-content:space-between}.brand{font-size:22px;font-weight:650}.badge{font-size:12px;padding:6px 10px;border:1px solid #adc5b1;border-radius:20px}h1{font-size:30px;line-height:1.3;margin-top:32px}h2{font-size:18px}h3{font-size:14px}p,footer{line-height:1.8;overflow-wrap:anywhere}section{padding:20px;margin:18px 0;background:#fff;border:1px solid #dce5d8;border-radius:12px;min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-width:100%;margin:12px 0 22px;padding:14px;background:#f5f7f4;border:1px solid #e0e7dc;border-radius:8px;font:13px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;unicode-bidi:plaintext}label{display:block;margin:12px 0 8px}input,select,textarea,button{font:inherit;border:1px solid #bbcdbb;border-radius:8px;padding:11px 13px;max-width:100%;min-height:44px}input,select,textarea{display:block;width:100%;margin:8px 0 12px;background:#fff;color:inherit}textarea{resize:vertical}button{background:#edf4e9;color:#244a32;cursor:pointer}button:disabled{opacity:.5;cursor:not-allowed}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,pre:focus-visible{outline:3px solid #6c926a;outline-offset:3px}#review-allow,#review-answer-submit{background:#28553b;color:#fff}#review-status{padding:14px;border-left:4px solid #7a9a70;background:#e9f0e5}#review-notice{color:#855122}.identity{font:12px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;unicode-bidi:plaintext}footer{font-size:12px;color:#607360;margin-top:28px}[hidden]{display:none!important}@media(max-width:600px){main{padding:22px 14px 36px}h1{font-size:26px}section{padding:15px}.actions{align-items:stretch;flex-direction:column}.actions button{width:100%}pre{padding:10px;font-size:12px}header{align-items:flex-start}}`;
