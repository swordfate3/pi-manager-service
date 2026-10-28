import type { ServerResponse } from "node:http";
import { createHash } from "node:crypto";

const responseHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** Standalone host-local Hub. Its script is served by renderLocalScript at /local.js. */
export function renderLocalPage(res: ServerResponse) {
  res.writeHead(200, {
    ...responseHeaders,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi · 本地工作台</title>
<style>
:root{color-scheme:light;--ink:#192b30;--muted:#52666b;--line:#dce5e3;--accent:#146557;--soft:#eef6f2}
*{box-sizing:border-box}body{margin:0;background:#f5f7f4;color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1040px;margin:auto;padding:36px 24px 56px}
a{color:var(--accent);text-underline-offset:4px}header,.section-head,.actions,.folder-nav{display:flex;align-items:center;gap:12px;flex-wrap:wrap}header{justify-content:space-between;margin-bottom:26px}.brand{display:flex;align-items:center;gap:12px}.mark{display:grid;place-items:center;background:var(--accent);color:white;width:44px;height:44px;border-radius:14px;font-weight:750}.eyebrow{margin:0;color:var(--muted);font-size:13px;letter-spacing:.08em}h1{font-size:24px;line-height:1.3;margin:0}h2{font-size:19px;margin:0}p{margin:10px 0}.intro{color:var(--muted);margin-bottom:24px}.layout{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:22px;align-items:start}
section{background:#fff;border:1px solid var(--line);border-radius:18px;padding:24px;min-width:0;box-shadow:0 5px 20px #182d2610}.section-head{justify-content:space-between;margin-bottom:18px}.step{display:inline-grid;place-items:center;width:25px;height:25px;border-radius:50%;background:var(--soft);color:var(--accent);font-size:13px;margin-right:8px}.muted,small{color:var(--muted)}small{font-size:13px}label{display:block;font-size:14px;color:var(--muted);margin:14px 0 6px}
button,select{font:inherit;max-width:100%;border:1px solid #c8d7d2;border-radius:10px;padding:9px 13px;background:white;color:var(--ink)}button{cursor:pointer;min-height:44px}button:hover:not(:disabled){background:var(--soft);border-color:var(--accent)}button:focus-visible,select:focus-visible,a:focus-visible{outline:3px solid #68aa98;outline-offset:3px}button:disabled,select:disabled{opacity:.5;cursor:default}select{width:100%;min-height:44px}button.primary{background:var(--accent);color:white;border-color:var(--accent);width:100%;margin-top:16px;font-weight:650}button.primary:hover:not(:disabled){background:#0b5145}button.danger{color:#9d3530}.folder-nav{margin-top:12px}.workspace{display:block;background:var(--soft);border:1px solid #d6e7df;border-radius:10px;padding:12px;overflow-wrap:anywhere;white-space:pre-wrap;font:14px/1.6 ui-monospace,monospace;min-height:48px}
#local-directories,#local-runs{list-style:none;margin:14px 0 0;padding:0}#local-directories{max-height:300px;overflow:auto}#local-directories li{margin:6px 0}#local-directories button{width:100%;text-align:left;overflow-wrap:anywhere;white-space:pre-wrap}#local-runs li{border-top:1px solid var(--line);padding:17px 0;overflow-wrap:anywhere}#local-runs li:first-child{border-top:0;padding-top:0}#local-runs h3{font-size:15px;margin:0 0 6px}.badge{display:inline-block;background:var(--soft);color:var(--accent);border-radius:6px;padding:2px 8px;font-size:13px}.run-workspace{font-size:13px;color:var(--muted);white-space:pre-wrap}.actions{margin-top:12px}.notice{color:#8b5117;font-size:14px}#local-status,#local-browser-status{overflow-wrap:anywhere;white-space:pre-wrap;font-size:14px}#local-status{min-height:28px;margin:18px 0}.footer{margin-top:20px;color:var(--muted);font-size:13px}[hidden]{display:none!important}
@media(max-width:720px){main{padding:22px 16px 36px}.layout{grid-template-columns:minmax(0,1fr)}section{padding:20px}.intro{font-size:14px}header{gap:16px}h1{font-size:21px}}
@media(prefers-reduced-motion:no-preference){button{transition:background .15s,border-color .15s}}
</style></head>
<body><main>
<header><div class="brand"><span class="mark" aria-hidden="true">Pi</span><div><p class="eyebrow">LOCAL HUB</p><h1>本地工作台</h1></div></div><nav class="actions"><a href="/sessions/">本地会话</a><a href="/account">账号与退出</a></nav></header>
<p class="intro">选好工作区，启动原始 pirun。会话就绪后，本页会自动进入。</p>
<div class="layout">
<section aria-labelledby="workspace-heading"><h2 id="workspace-heading"><span class="step" aria-hidden="true">1</span>选择工作区</h2>
<label for="local-root">项目根目录</label><select id="local-root" disabled aria-label="项目根目录"></select>
<label for="local-workspace">当前文件夹 · 进入即选中</label><output id="local-workspace" class="workspace">正在读取默认工作区…</output>
<div class="folder-nav"><button id="local-parent" type="button" disabled>上一级</button><button id="local-home" type="button" disabled>根目录</button></div>
<p id="local-browser-status" role="status" aria-live="polite">正在读取工作区…</p>
<ul id="local-directories" aria-label="子文件夹"></ul>
<p id="local-truncated" class="notice" hidden>子目录较多，仅显示部分结果。可继续进入已列出的文件夹。</p>
<button id="local-browse-retry" type="button" hidden>重试读取目录</button>
<button id="local-start" class="primary" type="button" disabled>启动并进入会话</button>
<p class="footer">实例名称自动生成，无需填写。工作区会在启动时再次由本机服务校验。</p>
</section>
<section aria-labelledby="runs-heading"><div class="section-head"><h2 id="runs-heading"><span class="step" aria-hidden="true">2</span>本机实例</h2><button id="local-refresh" type="button">刷新状态</button></div>
<p class="muted">已有会话可手动打开；停止前会再次确认，确认停止后自动移出列表。</p><ul id="local-runs" aria-label="本机实例"></ul></section>
</div>
<p id="local-status" role="status" aria-live="polite">正在连接本机服务…</p>
<noscript><p class="notice">请启用 JavaScript 后使用本地工作台。</p></noscript>
<p class="footer">已登录设备可以管理本机实例。状态未确认时，请查看服务状态并刷新，勿重复启动。</p>
</main><script src="/local.js" defer></script></body></html>`);
}

export function renderLocalScript(res: ServerResponse, ifNoneMatch?:string) {
  const headers={ ...responseHeaders,"Cache-Control":"private, no-cache",ETag:scriptTag, "Content-Type": "text/javascript; charset=utf-8" };
  if(ifNoneMatch === scriptTag) {res.writeHead(304,headers);res.end();return;}
  res.writeHead(200,headers);
  res.end(localScript);
}

// No browser storage: CSRF and the in-flight start identity belong to this page only.
const localScript = String.raw`"use strict";
(() => {
  const el = id => document.getElementById(id);
  const states = {starting:'正在启动',ready:'可进入',failed:'启动失败',stopping:'正在停止',stopped:'已停止',unknown:'状态未确认'};
  let csrf = '', roots = [], runs = [], selected = null, requested = null;
  let configured = false, healthy = false, browsing = false, browseGeneration = 0;
  let pending = null, posting = false, refreshing = false, pollTimer = null, navigated = false;
  const stopping = new Set();
  const status = text => { el('local-status').textContent = text; };
  const validPath = path => typeof path === 'string' && !/[\\\u0000-\u001f\u007f]/.test(path) &&
    (path === '' || path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
  const validWorkspace = value => value && typeof value.root === 'string' && value.root !== '' && validPath(value.path);
  const allowed = value => validWorkspace(value) && roots.some(root => root.id === value.root);
  const validRun = value => value && typeof value.id === 'string' && value.id !== '' && validWorkspace(value.workspace) &&
    Object.hasOwn(states, value.state) && (value.path === undefined || typeof value.path === 'string') &&
    (value.error === undefined || typeof value.error === 'string');
  const validState = value => value && typeof value.csrfToken === 'string' && value.csrfToken !== '' && value.browser &&
    Array.isArray(value.browser.roots) && value.browser.roots.length > 0 && value.browser.roots.every(root => root &&
      typeof root.id === 'string' && root.id !== '' && typeof root.label === 'string') &&
    new Set(value.browser.roots.map(root => root.id)).size === value.browser.roots.length &&
    value.browser.roots.some(root => root.id === value.browser.defaultRoot) && validWorkspace(value.defaultWorkspace) &&
    value.browser.roots.some(root => root.id === value.defaultWorkspace.root) && Array.isArray(value.runs) && value.runs.every(validRun);
  // Never accept an absolute URL, dot traversal, query, fragment, or encoded separator.
  const sessionPath = path => typeof path === 'string' && /^\/s\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/$/.test(path);
  const workspaceText = value => {
    const root = roots.find(item => item.id === value.root);
    return (root ? root.label : value.root) + ' / ' + (value.path || '（根目录）');
  };
  function controls() {
    const locked = !!pending || posting;
    el('local-root').disabled = !configured || !healthy || locked;
    el('local-home').disabled = !configured || !healthy || locked || !requested;
    el('local-parent').disabled = !configured || !healthy || locked || !requested || requested.path === '';
    el('local-start').disabled = !healthy || !allowed(selected) || browsing || posting || !!(pending && pending.id);
    el('local-start').textContent = posting ? '正在提交启动…' : pending ? (pending.id ? '等待会话就绪…' : '重试启动（不会重复创建）') : '启动并进入会话';
    for (const item of el('local-directories').children) {
      for (const button of item.children) button.disabled = locked || !healthy || browsing;
    }
  }
  async function api(route, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const headers = {};
      if (body !== undefined) {
        if (!csrf) throw Error('本机连接尚未就绪，请刷新状态。');
        headers['Content-Type'] = 'application/json';
        headers['X-Pi-Local-Csrf'] = csrf;
      }
      const response = await fetch('/api/local/' + route, {
        method:body === undefined ? 'GET' : 'POST', headers, credentials:'same-origin', cache:'no-store',
        body:body === undefined ? undefined : JSON.stringify(body), signal:controller.signal,
      });
      const value = await response.json();
      if (!response.ok) {
        if (response.status === 401) {window.location.assign('/login');throw Error('登录已过期，请重新登录。');}
        const error = Error(value && typeof value.error === 'string' ? value.error : '本机服务暂时不可用，请重试。');
        error.status = response.status;
        throw error;
      }
      return value;
    } finally { clearTimeout(timeout); }
  }
  const explanation = (error, fallback) => error && error.status && error.message ? error.message : fallback;
  function validDirectory(page, root, path) {
    return page && page.root === root && page.path === path && typeof page.truncated === 'boolean' && Array.isArray(page.directories) &&
      page.directories.every(item => item && typeof item.name === 'string' && item.name !== '' && item.name !== '.' && item.name !== '..' &&
        !/[\/\\\u0000-\u001f\u007f]/.test(item.name) && item.path === (path ? path + '/' : '') + item.name && validPath(item.path));
  }
  async function browse(root, path) {
    if (pending || posting) return;
    const generation = ++browseGeneration;
    requested = {root,path}; selected = null; browsing = true;
    el('local-workspace').textContent = workspaceText(requested);
    el('local-root').value = root;
    el('local-directories').replaceChildren();
    el('local-truncated').hidden = true;
    el('local-browse-retry').hidden = true;
    el('local-browser-status').textContent = '正在校验当前文件夹并读取子目录…';
    controls();
    try {
      if (!allowed(requested)) throw Error('目录信息无效，请重新选择根目录。');
      const page = await api('browse', {root,path});
      if (generation !== browseGeneration) return;
      if (!validDirectory(page, root, path)) throw Error('目录响应无效或与当前文件夹不匹配，请重试。');
      // Configured roots can contain protected children. Listing a root is not permission to launch there.
      selected = path === '' ? null : {root,path};
      for (const directory of page.directories) {
        const item = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.textContent = directory.name;
        button.addEventListener('click', () => browse(root, directory.path));
        item.append(button); el('local-directories').append(item);
      }
      el('local-browser-status').textContent = path === '' ? '根目录仅用于浏览，请进入允许的子文件夹后启动。' :
        page.directories.length ? '当前文件夹已选中，也可继续进入子文件夹。' : '当前文件夹已选中，没有可显示的子文件夹。';
      el('local-truncated').hidden = !page.truncated;
    } catch (error) {
      if (generation !== browseGeneration) return;
      selected = null;
      el('local-browser-status').textContent = error.status ? error.message :
        (/目录/.test(error.message) ? error.message : '无法读取目录，请检查本机连接后重试。');
      el('local-browse-retry').hidden = false;
    } finally {
      if (generation === browseGeneration) { browsing = false; controls(); }
    }
  }
  function upsert(value) {
    runs = [value, ...runs.filter(item => item.id !== value.id)];
    renderRuns();
  }
  function openRun(value) {
    if (!sessionPath(value.path)) { status('会话地址尚未就绪或无效，请刷新状态后再打开。'); return false; }
    location.assign(value.path);
    return true;
  }
  function follow(value) {
    if (!pending || !pending.id || pending.id !== value.id || navigated) return;
    if (value.state === 'ready') {
      status('会话已就绪，正在进入…');
      // Mark before navigation: polling cannot send the user twice while unloading.
      if (sessionPath(value.path)) { navigated = true; openRun(value); }
      else status('会话已就绪，但会话地址尚未就绪或无效。请刷新状态，勿重复启动。');
    } else if (value.state === 'failed') {
      status('启动失败：' + (value.error || '原始 pirun 未能启动。') + ' 请查看本地服务状态并刷新，检查工作区，确认原因后再手动重试。');
      pending = null;
    } else if (value.state === 'unknown') {
      status('实例状态未确认：' + (value.error || '暂时无法确认进程状态。') + ' 请查看本地服务状态并刷新，勿重复启动。');
    } else if (value.state === 'stopped') {
      status('本次实例已停止。请查看本地服务状态并刷新，确认后可重新启动。'); pending = null;
    } else if (value.state === 'stopping') status('实例正在停止，请等待状态确认，勿重复启动。');
    else status('原始 pirun 正在启动，等待会话就绪后自动进入…');
    controls();
  }
  function renderRuns() {
    const list = el('local-runs'); list.replaceChildren();
    // Keep the full response for pending-start reconciliation and idempotent retries.
    // Only confirmed stopped instances leave the visible list; uncertain/failing runs need attention.
    const visibleRuns = runs.filter(value => value.state !== 'stopped');
    if (!visibleRuns.length) {
      const empty = document.createElement('li'); empty.textContent = '暂无运行中的本机实例，选择工作区即可启动。'; list.append(empty); return;
    }
    for (const value of visibleRuns) {
      const item = document.createElement('li'), name = document.createElement('h3'), badge = document.createElement('span');
      name.textContent = value.id; badge.className = 'badge'; badge.textContent = states[value.state];
      const folder = document.createElement('p'); folder.className = 'run-workspace'; folder.textContent = workspaceText(value.workspace);
      item.append(name, badge, folder);
      if (value.error || value.state === 'unknown' || value.state === 'failed') {
        const note = document.createElement('p'); note.className = 'notice';
        note.textContent = (value.error ? value.error + ' ' : '') +
          (value.state === 'unknown' ? '请查看本地服务状态并刷新，勿重复启动。' :
           value.state === 'failed' ? '请查看本地服务状态并刷新，检查工作区，确认原因后再手动重试。' : '');
        item.append(note);
      }
      const actions = document.createElement('div'); actions.className = 'actions';
      if (value.state === 'ready' && sessionPath(value.path)) {
        const open = document.createElement('button'); open.type = 'button'; open.textContent = '打开';
        open.setAttribute('aria-label', '打开'); open.addEventListener('click', () => openRun(value)); actions.append(open);
      }
      if (['starting','ready','unknown'].includes(value.state)) {
        const stop = document.createElement('button'); stop.type = 'button'; stop.className = 'danger'; stop.textContent = '停止';
        stop.disabled = !healthy || stopping.has(value.id);
        stop.addEventListener('click', () => stopRun(value)); actions.append(stop);
      }
      item.append(actions); list.append(item);
    }
  }
  async function stopRun(value) {
    if (!healthy || stopping.has(value.id) || !window.confirm('确认停止实例「' + value.id + '」？这会结束该实例的运行。')) return;
    stopping.add(value.id); renderRuns();
    try {
      const result = await api('stop', {id:value.id});
      if (!validRun(result) || result.id !== value.id) throw Error('停止响应无效。');
      upsert(result);
      status(result.state === 'stopped' ? '实例已停止。' : '停止请求已提交，正在确认状态…');
      follow(result);
    } catch (error) {
      status(explanation(error, '停止结果未确认，请查看本地服务状态并刷新，勿重复启动。'));
    } finally { stopping.delete(value.id); renderRuns(); schedulePoll(); }
  }
  async function start() {
    if (posting || !healthy || browsing || !allowed(selected) || (pending && pending.id)) return;
    try {
      if (!pending) pending = {key:crypto.randomUUID(), workspace:{root:selected.root,path:selected.path}};
    } catch (_) { status('浏览器无法生成安全启动标识，请使用本机 localhost 或 HTTPS 地址后重试。'); return; }
    posting = true; controls(); status('正在提交原始 pirun 启动请求…');
    try {
      const value = await api('start', {key:pending.key,workspace:pending.workspace});
      if (!validRun(value) || value.workspace.root !== pending.workspace.root || value.workspace.path !== pending.workspace.path) throw Error('启动响应无效。');
      pending.id = value.id; upsert(value); follow(value);
    } catch (error) {
      status(explanation(error, '启动结果未确认。请保留本页并重试启动，将复用同一请求，不会重复创建实例。') +
        (error.status ? ' 请检查提示后重试；未确认的请求将复用同一启动标识。' : ''));
      // A definitive input rejection cannot have created a run. Uncertain failures keep the exact request.
      if (error.status === 400 || error.status === 422) pending = null;
    } finally { posting = false; controls(); schedulePoll(); }
  }
  function schedulePoll() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    const waiting = pending || runs.some(value => ['starting','stopping','unknown'].includes(value.state));
    pollTimer = setTimeout(refresh, waiting ? 1200 : 5000);
  }
  async function refresh() {
    if (refreshing) return;
    refreshing = true; el('local-refresh').disabled = true;
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; }
    try {
      const value = await api('state');
      if (!validState(value)) throw Error('本机状态响应无效。');
      const recovered = configured && !healthy;
      csrf = value.csrfToken; healthy = true; roots = value.browser.roots; runs = value.runs;
      const rootSelect = el('local-root'), previousRoot = requested ? requested.root : value.defaultWorkspace.root;
      rootSelect.replaceChildren();
      for (const root of roots) {
        const option = document.createElement('option'); option.value = root.id; option.textContent = root.label; rootSelect.append(option);
      }
      rootSelect.value = previousRoot;
      renderRuns();
      if (recovered) status(pending && !pending.id ? '本机连接已恢复。启动结果仍未确认，请重试启动，将复用同一请求。' : '本机连接已恢复，当前工作区已保留。');
      if (!configured) {
        configured = true; status('本机服务已连接。选择工作区后即可启动。');
        await browse(value.defaultWorkspace.root, value.defaultWorkspace.path);
      } else if (selected && !allowed(selected)) {
        ++browseGeneration; browsing = false; selected = null;
        el('local-directories').replaceChildren();
        el('local-browser-status').textContent = '当前项目根目录已不可用，请重新选择。';
      }
      if (pending && pending.id) {
        const match = runs.find(item => item.id === pending.id);
        if (match) follow(match);
        else status('本次启动尚未出现在实例列表中，正在继续刷新。请查看本地服务状态并刷新，勿重复启动。');
      }
    } catch (error) {
      healthy = false;
      status(explanation(error, '无法刷新本机状态，请检查本机服务与连接，稍后重试。') + (pending ? ' 本次启动仍保留，请勿重复创建实例。' : ''));
      renderRuns();
    } finally { refreshing = false; el('local-refresh').disabled = false; controls(); schedulePoll(); }
  }
  el('local-root').addEventListener('change', () => browse(el('local-root').value, ''));
  el('local-home').addEventListener('click', () => requested && browse(requested.root, ''));
  el('local-parent').addEventListener('click', () => requested && requested.path !== '' && browse(requested.root, requested.path.split('/').slice(0,-1).join('/')));
  el('local-browse-retry').addEventListener('click', () => requested && browse(requested.root, requested.path));
  el('local-start').addEventListener('click', start);
  el('local-refresh').addEventListener('click', refresh);
  void refresh();
})();`;
const scriptTag='"'+createHash("sha256").update(localScript).digest("hex")+'"';
