import type { ServerResponse } from "node:http";

export function renderPage(res: ServerResponse, admin: boolean, chatOrigin: string) {
  const chatLink = new URL("/sessions/", chatOrigin).href.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Manager</title>
<style>body{font:16px system-ui;background:#f4f6fa;color:#17253d;margin:0}main{max-width:850px;margin:32px auto;padding:20px}section{background:white;border:1px solid #ccd5e2;border-radius:12px;padding:20px;margin:18px 0}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:10px;max-width:100%;box-sizing:border-box}input,select{width:100%}button{cursor:pointer;margin:5px 8px 5px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}#message{min-height:24px}li{margin:15px 0;overflow-wrap:anywhere}.notice{color:#61451b}button:disabled{cursor:default;opacity:.5}fieldset{border:1px solid #ccd5e2;border-radius:8px;margin:12px 0;padding:12px}#workspace-directories{padding-left:0;list-style:none}#workspace-directories li{margin:4px 0}#workspace-directories button{width:100%;text-align:left}</style>
<main data-admin="${admin}"><h1>Pi Manager</h1><p>Independent task management · available with zero Pi instances</p>
<nav><a href="${chatLink}" rel="noreferrer">Open Pi sessions</a> · Management credentials are never forwarded to the chat portal.</nav>
<p class="notice">Native execution is trusted-local development only, not untrusted isolation. Docker uses an administrator-fixed profile. Updates are not enabled.</p>
<section><h2>${admin ? "Private administrator entry" : "Task requester entry"}</h2><p>${admin ? "Enter your separately provisioned administrator credential. Agent credentials cannot approve. You cannot approve your own request." : "Enter a requester credential. Approval happens separately in the private administrator entry."}</p>
<form id="login"><label>Credential<input id="credential" type="password" autocomplete="off" required></label><button>Unlock</button></form><button id="logout" hidden>Lock</button></section>
<p id="message" role="status" aria-live="polite"></p><section id="content" hidden><h2>Create or stop a managed Pi</h2><p id="capabilities"></p>
<h2>Official Pi release catalog</h2><p>This catalog is read-only. Update execution is not enabled, and a listed release does not imply candidate compatibility or approval.</p>
<form id="version-search"><label>Numeric version prefix<input id="version-query" inputmode="decimal" pattern="[0-9.]*" maxlength="64" autocomplete="off"></label><button>Search official versions</button></form>
<p id="catalog-status" role="status">Catalog locked.</p><ul id="versions"></ul><button id="versions-next" type="button" hidden>Next page</button>
<form id="task"><label>Action<select id="action"><option value="create">Create managed Pi</option><option value="stop">Stop owned Pi</option><option value="start" hidden>Restore owned Pi</option></select></label><label>Target ID<input id="target" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" maxlength="64" required></label><label id="workspace-static-label">Allowed directory<select id="workspace"></select></label><fieldset id="workspace-browser" hidden><legend>Allowed project directory</legend><label>Project root<select id="workspace-root"></select></label><p>Browsing: <code id="workspace-current">/</code></p><button id="workspace-parent" type="button">Parent</button><button id="workspace-home" type="button">Root</button><ul id="workspace-directories"></ul><p id="workspace-truncated" class="notice" hidden>Only the first 200 allowed directories are shown.</p><button id="workspace-select" type="button">Select current folder</button><p>Selected: <code id="workspace-selected">None</code></p></fieldset><button id="submit">Submit for independent approval</button></form>
<button id="refresh">Refresh tasks</button><h2>Tasks</h2><p>After a lost response, refresh to reconcile before any new action. Restarted queued tasks require fresh review and approval; unknown tasks are never replayed.</p><ul id="tasks"></ul></section>
<section id="review" hidden><h2>Exact task review</h2><pre id="review-data"></pre><button id="approve">Approve and execute this revision</button><button id="cancel">Close review</button></section></main><script src="/app.js" defer></script></html>`);
}

export const browserScript = `"use strict";
const el = id => document.getElementById(id);
const administrator = document.querySelector('main').dataset.admin === 'true';
let credential = '', reviewed = null, busy = false, lastSubmission = null, catalogGeneration = 0, catalogQuery = '', catalogCursor = null;
let sessionGeneration = 0, directoryGeneration = 0, browserPolicy = null, currentDirectory = null, selectedWorkspace = null, lifecycleAvailable = false;
const message = text => { el('message').textContent = text; };
const currentSession = (generation, authority) => generation === sessionGeneration && credential === authority && !!credential;
async function api(route, data) {
  const headers = {};
  if (credential) headers['X-Pi-Manager-Token'] = credential;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/manager/' + route, {method:data === undefined ? 'GET':'POST',headers,credentials:'same-origin',cache:'no-store',body:data === undefined ? undefined:JSON.stringify(data)});
  const value = await response.json(); if (!response.ok) throw Error(value.error || 'Request failed'); return value;
}
function hideReview() { reviewed = null; el('review').hidden = true; el('review-data').textContent = ''; }
function updateSubmit() {
  const needsSelection = el('action').value === 'create' && browserPolicy && !selectedWorkspace;
  el('submit').disabled = busy || !lifecycleAvailable || !!needsSelection;
}
function resetWorkspace() {
  directoryGeneration++; browserPolicy = null; currentDirectory = null; selectedWorkspace = null;
  el('workspace').replaceChildren(); el('workspace-root').replaceChildren(); el('workspace-directories').replaceChildren();
  el('workspace-static-label').hidden = false; el('workspace-browser').hidden = true; el('workspace-current').textContent = '/';
  el('workspace-selected').textContent = 'None'; el('workspace-truncated').hidden = true; el('workspace-parent').disabled = true; el('workspace-select').disabled = true;
}
function validDirectoryPage(page, root, path) {
  return page && page.root === root && page.path === path && typeof page.truncated === 'boolean' && Array.isArray(page.directories) && page.directories.length <= 200 &&
    page.directories.every(entry => entry && typeof entry.name === 'string' && entry.name && !entry.name.includes('/') && !entry.name.includes('\\\\') && typeof entry.path === 'string');
}
async function loadDirectory(root, path) {
  const generation = ++directoryGeneration, session = sessionGeneration;
  currentDirectory = null; el('workspace-select').disabled = true;
  el('workspace-directories').replaceChildren(); el('workspace-truncated').hidden = true; el('workspace-current').textContent = path || '/';
  try {
    const page = await api('workspaces/browse', {root, path});
    if (generation !== directoryGeneration || session !== sessionGeneration || !credential || !browserPolicy) return;
    if (!validDirectoryPage(page, root, path)) throw Error('Directory response invalid');
    currentDirectory = {root, path}; el('workspace-select').disabled = false; el('workspace-root').value = root; el('workspace-current').textContent = path || '/';
    el('workspace-parent').disabled = path === '';
    for (const directory of page.directories) {
      const item = document.createElement('li'), button = document.createElement('button'); button.type = 'button'; button.textContent = directory.name;
      button.onclick = () => loadDirectory(root, directory.path); item.append(button); el('workspace-directories').append(item);
    }
    el('workspace-truncated').hidden = !page.truncated;
  } catch(e) { if (generation === directoryGeneration && session === sessionGeneration && credential) message(e.message); }
}
async function configureWorkspaceBrowser(policy, choices) {
  resetWorkspace();
  if (policy === null) {
    for (const w of choices) { const option = document.createElement('option'); option.value = w.id; option.textContent = w.label; el('workspace').append(option); }
    updateSubmit(); return;
  }
  if (!policy || typeof policy.defaultRoot !== 'string' || !Array.isArray(policy.roots) || !policy.roots.length ||
      !policy.roots.every(root => root && typeof root.id === 'string' && typeof root.label === 'string') || !policy.roots.some(root => root.id === policy.defaultRoot)) throw Error('Workspace browser response invalid');
  browserPolicy = policy; el('workspace-static-label').hidden = true; el('workspace-browser').hidden = false;
  for (const root of policy.roots) { const option = document.createElement('option'); option.value = root.id; option.textContent = root.label; el('workspace-root').append(option); }
  updateSubmit(); await loadDirectory(policy.defaultRoot, '');
}
function resetCatalog() {
  catalogGeneration++; catalogQuery = ''; catalogCursor = null; el('version-query').value = '';
  el('versions').replaceChildren(); el('versions-next').hidden = true; el('catalog-status').textContent = 'Catalog locked.';
}
async function loadVersions(append) {
  const generation = ++catalogGeneration;
  const options = {query:catalogQuery,limit:50}; if (append && catalogCursor) options.cursor = catalogCursor;
  el('catalog-status').textContent = 'Checking the read-only official Pi release catalog...';
  try {
    const page = await api('versions', options);
    if (generation !== catalogGeneration || !credential) return;
    if (!['fresh','stale','unavailable'].includes(page.status) || !Array.isArray(page.versions) ||
        !page.versions.every(version => typeof version === 'string' && /^[0-9]+\\.[0-9]+\\.[0-9]+$/.test(version))) throw Error('Catalog response invalid');
    if (!append) el('versions').replaceChildren();
    for (const version of page.versions) { const item = document.createElement('li'); item.textContent = version; el('versions').append(item); }
    catalogCursor = typeof page.nextCursor === 'string' ? page.nextCursor : null; el('versions-next').hidden = !catalogCursor;
    const readOnly = ' Read-only; update execution is not enabled and compatibility is not implied.';
    el('catalog-status').textContent = page.status === 'fresh' ? 'Official Pi release catalog is fresh.' + readOnly :
      page.status === 'stale' ? 'Official registry unavailable; showing stale cached versions.' + readOnly :
      'Official Pi release catalog unavailable. No official versions are available.' + readOnly;
  } catch(e) {
    if (generation !== catalogGeneration || !credential) return;
    if (!append) el('versions').replaceChildren(); catalogCursor = null; el('versions-next').hidden = true;
    el('catalog-status').textContent = 'Official Pi release catalog unavailable. Read-only update execution remains disabled.';
  }
}
async function refresh() {
  const generation = sessionGeneration, authority = credential;
  const tasks = await api('tasks'); if (!currentSession(generation, authority)) return; el('tasks').replaceChildren();
  for (const task of tasks) {
    const item = document.createElement('li');
    const label = document.createElement('span'); label.textContent = task.id + ' · ' + task.requester + ' · ' + task.action + ' ' + task.target + ' · ' + task.state + ' (r' + task.revision + ')'; item.append(label);
    if (administrator && ['pending_approval','queued'].includes(task.state)) {
      const button = document.createElement('button'); button.textContent = 'Review';
      button.onclick = async () => {
        const reviewGeneration = sessionGeneration, reviewAuthority = credential;
        try {
          const response = await api('tasks/' + task.id + '/review'); if (!currentSession(reviewGeneration, reviewAuthority)) return;
          reviewed = response; el('review-data').textContent = JSON.stringify(reviewed, null, 2); el('approve').textContent = reviewed.requiresFreshApproval ? 'Approve and execute this revision' : 'Execute this already approved revision'; el('review').hidden = false;
        } catch(e) { if (currentSession(reviewGeneration, reviewAuthority)) message(e.message); }
      };
      item.append(button);
    }
    el('tasks').append(item);
  }
}
el('login').onsubmit = async e => {
  e.preventDefault(); const generation = ++sessionGeneration; directoryGeneration++; const input = el('credential').value; el('credential').value = ''; credential = '';
  try {
    const authenticated = administrator ? (await api('login', {credential:input})).sessionToken : input;
    if (generation !== sessionGeneration) return; credential = authenticated;
    const [capabilities, choices, workspaceBrowser] = await Promise.all([api('capabilities'), api('workspaces'), api('workspace-browser')]);
    if (generation !== sessionGeneration || credential !== authenticated) return;
    el('capabilities').textContent = (capabilities.native ? 'Native: trusted-local development.' : capabilities.docker ? 'Docker: fixed container profile.' : 'Lifecycle execution is not configured.') + (capabilities.enrollment ? ' Explicit Web enrollment configured.' : ' Web enrollment is not configured.') + ' Updates unavailable. Official release discovery is read-only.';
    el('action').querySelector('[value="start"]').hidden = !(capabilities.docker || capabilities.native && capabilities.enrollment);
    lifecycleAvailable = !!(capabilities.native || capabilities.docker); await configureWorkspaceBrowser(workspaceBrowser, choices);
    if (generation !== sessionGeneration || credential !== authenticated) return;
    el('content').hidden = false; el('login').hidden = true; el('logout').hidden = false; message('Unlocked. No task has been approved.'); await refresh(); await loadVersions(false);
  } catch(e) { if (generation !== sessionGeneration) return; credential = ''; lifecycleAvailable = false; resetWorkspace(); resetCatalog(); updateSubmit(); message(e.message); }
};
el('version-search').onsubmit = async e => { e.preventDefault(); catalogQuery = el('version-query').value; catalogCursor = null; await loadVersions(false); };
el('versions-next').onclick = () => { if (catalogCursor) return loadVersions(true); };
el('task').onsubmit = async e => {
  e.preventDefault(); if (busy) return; const generation = sessionGeneration, authority = credential; busy = true; el('submit').disabled = true;
  const request = {action:el('action').value,target:el('target').value};
  if (request.action === 'create') {
    if (browserPolicy && !selectedWorkspace) { busy = false; updateSubmit(); message('Select an allowed project directory first.'); return; }
    request.workspace = browserPolicy ? {...selectedWorkspace} : el('workspace').value;
  }
  const signature = JSON.stringify(request);
  if (!lastSubmission || lastSubmission.signature !== signature) lastSubmission = {signature,key:crypto.randomUUID()};
  try { const task = await api('tasks', {...request,key:lastSubmission.key}); if (!currentSession(generation, authority)) return; message('Task ' + task.id + ': ' + task.state); await refresh(); }
  catch(e) { if (currentSession(generation, authority)) message(e.message + '. Delivery may be unknown; refresh tasks before retrying. The same unchanged request retains its idempotency key.'); }
  finally { if (currentSession(generation, authority)) { busy = false; updateSubmit(); } }
};
el('approve').onclick = async () => {
  if (!reviewed || busy) return;
  if (!confirm('Approve exactly ' + reviewed.task.action + ' ' + reviewed.task.target + ' at revision ' + reviewed.binding.revision + '?')) return;
  const generation = sessionGeneration, authority = credential;
  busy = true; el('approve').disabled = true; const binding = reviewed.binding; const fresh = reviewed.requiresFreshApproval; hideReview();
  try { await api(fresh ? 'approve':'execute',fresh ? binding : {taskId:binding.taskId,revision:binding.revision}); if (!currentSession(generation, authority)) return; message('Approval accepted; execution is owned by the executor.'); await refresh(); }
  catch(e) { if (currentSession(generation, authority)) message(e.message + '. Refresh and review current state; do not replay an approval.'); }
  finally { if (currentSession(generation, authority)) { busy = false; el('approve').disabled = false; } }
};
el('refresh').onclick = () => { const generation = sessionGeneration, authority = credential; return refresh().catch(e => { if (currentSession(generation, authority)) message(e.message); }); };
el('cancel').onclick = hideReview;
el('action').onchange = updateSubmit;
el('workspace-root').onchange = () => loadDirectory(el('workspace-root').value, '');
el('workspace-parent').onclick = () => { if (!currentDirectory || currentDirectory.path === '') return; const parts = currentDirectory.path.split('/'); parts.pop(); return loadDirectory(currentDirectory.root, parts.join('/')); };
el('workspace-home').onclick = () => { if (browserPolicy) return loadDirectory(el('workspace-root').value || browserPolicy.defaultRoot, ''); };
el('workspace-select').onclick = () => {
  if (!currentDirectory || el('workspace-select').disabled) return; selectedWorkspace = {...currentDirectory};
  el('workspace-selected').textContent = selectedWorkspace.root + ':' + (selectedWorkspace.path || '/'); lastSubmission = null; updateSubmit();
};
el('logout').onclick = async () => {
  sessionGeneration++; directoryGeneration++; catalogGeneration++; busy = true; el('approve').disabled = true; hideReview(); updateSubmit(); el('catalog-status').textContent = 'Catalog refresh paused while logout is pending.';
  try { if (administrator) await api('logout',{}); }
  catch(e) { busy = false; el('approve').disabled = false; updateSubmit(); el('catalog-status').textContent = 'Logout failed. The catalog refresh was cancelled; search again to refresh.'; message(e.message); return; }
  credential = ''; lifecycleAvailable = false; lastSubmission = null; busy = false; el('approve').disabled = false; hideReview(); resetWorkspace(); resetCatalog(); updateSubmit(); el('content').hidden = true; el('tasks').replaceChildren(); el('login').hidden = false; el('logout').hidden = true; message('Locked.');
};
resetWorkspace(); resetCatalog(); updateSubmit();
`;

export function renderScript(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(browserScript);
}
