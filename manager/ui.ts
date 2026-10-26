import type { ServerResponse } from "node:http";

export function renderPage(res: ServerResponse, admin: boolean, chatOrigin: string) {
  const chatLink = new URL("/sessions/", chatOrigin).href.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pi Manager</title>
<style>body{font:16px system-ui;background:#f4f6fa;color:#17253d;margin:0}main{max-width:850px;margin:32px auto;padding:20px}section{background:white;border:1px solid #ccd5e2;border-radius:12px;padding:20px;margin:18px 0}label{display:block;margin:12px 0}input,select,button{font:inherit;padding:10px;max-width:100%;box-sizing:border-box}input,select{width:100%}button{cursor:pointer;margin:5px 8px 5px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}#message{min-height:24px}li{margin:15px 0;overflow-wrap:anywhere}.notice{color:#61451b}button:disabled{cursor:default;opacity:.5}</style>
<main data-admin="${admin}"><h1>Pi Manager</h1><p>Independent task management · available with zero Pi instances</p>
<nav><a href="${chatLink}" rel="noreferrer">Open Pi sessions</a> · Management credentials are never forwarded to the chat portal.</nav>
<p class="notice">Native execution is trusted-local development only, not untrusted isolation. Docker uses an administrator-fixed profile. Updates are not enabled.</p>
<section><h2>${admin ? "Private administrator entry" : "Task requester entry"}</h2><p>${admin ? "Enter your separately provisioned administrator credential. Agent credentials cannot approve. You cannot approve your own request." : "Enter a requester credential. Approval happens separately in the private administrator entry."}</p>
<form id="login"><label>Credential<input id="credential" type="password" autocomplete="off" required></label><button>Unlock</button></form><button id="logout" hidden>Lock</button></section>
<p id="message" role="status" aria-live="polite"></p><section id="content" hidden><h2>Create or stop a managed Pi</h2><p id="capabilities"></p>
<form id="task"><label>Action<select id="action"><option value="create">Create managed Pi</option><option value="stop">Stop owned Pi</option><option value="start" hidden>Restore owned Pi</option></select></label><label>Target ID<input id="target" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" maxlength="64" required></label><label>Allowed directory<select id="workspace"></select></label><button id="submit">Submit for independent approval</button></form>
<button id="refresh">Refresh tasks</button><h2>Tasks</h2><p>After a lost response, refresh to reconcile before any new action. Restarted queued tasks require fresh review and approval; unknown tasks are never replayed.</p><ul id="tasks"></ul></section>
<section id="review" hidden><h2>Exact task review</h2><pre id="review-data"></pre><button id="approve">Approve and execute this revision</button><button id="cancel">Close review</button></section></main><script src="/app.js" defer></script></html>`);
}

export const browserScript = `"use strict";
const el = id => document.getElementById(id);
const administrator = document.querySelector('main').dataset.admin === 'true';
let credential = '', reviewed = null, busy = false, lastSubmission = null;
const message = text => { el('message').textContent = text; };
async function api(route, data) {
  const headers = {};
  if (credential) headers.Authorization = 'Bearer ' + credential;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch('/api/manager/' + route, {method:data === undefined ? 'GET':'POST',headers,credentials:'same-origin',cache:'no-store',body:data === undefined ? undefined:JSON.stringify(data)});
  const value = await response.json(); if (!response.ok) throw Error(value.error || 'Request failed'); return value;
}
function hideReview() { reviewed = null; el('review').hidden = true; el('review-data').textContent = ''; }
async function refresh() {
  const tasks = await api('tasks'); el('tasks').replaceChildren();
  for (const task of tasks) {
    const item = document.createElement('li');
    const label = document.createElement('span'); label.textContent = task.id + ' · ' + task.requester + ' · ' + task.action + ' ' + task.target + ' · ' + task.state + ' (r' + task.revision + ')'; item.append(label);
    if (administrator && ['pending_approval','queued'].includes(task.state)) {
      const button = document.createElement('button'); button.textContent = 'Review';
      button.onclick = async () => { try { reviewed = await api('tasks/' + task.id + '/review'); el('review-data').textContent = JSON.stringify(reviewed, null, 2); el('approve').textContent = reviewed.requiresFreshApproval ? 'Approve and execute this revision' : 'Execute this already approved revision'; el('review').hidden = false; } catch(e) { message(e.message); } };
      item.append(button);
    }
    el('tasks').append(item);
  }
}
el('login').onsubmit = async e => {
  e.preventDefault(); const input = el('credential').value; el('credential').value = '';
  try {
    if (administrator) credential = (await api('login', {credential:input})).sessionToken; else credential = input;
    const capabilities = await api('capabilities'); const choices = await api('workspaces');
    el('capabilities').textContent = (capabilities.native ? 'Native: trusted-local development.' : capabilities.docker ? 'Docker: fixed container profile.' : 'Lifecycle execution is not configured.') + (capabilities.enrollment ? ' Explicit Web enrollment configured.' : ' Web enrollment is not configured.') + ' Updates unavailable.';
    el('action').querySelector('[value="start"]').hidden = !(capabilities.docker || capabilities.native && capabilities.enrollment);
    el('submit').disabled = !(capabilities.native || capabilities.docker); el('workspace').replaceChildren();
    for (const w of choices) { const option = document.createElement('option'); option.value = w.id; option.textContent = w.label; el('workspace').append(option); }
    el('content').hidden = false; el('login').hidden = true; el('logout').hidden = false; message('Unlocked. No task has been approved.'); await refresh();
  } catch(e) { credential = ''; message(e.message); }
};
el('task').onsubmit = async e => {
  e.preventDefault(); if (busy) return; busy = true; el('submit').disabled = true;
  const request = {action:el('action').value,target:el('target').value}; if (request.action === 'create') request.workspace = el('workspace').value;
  const signature = JSON.stringify(request);
  if (!lastSubmission || lastSubmission.signature !== signature) lastSubmission = {signature,key:crypto.randomUUID()};
  try { const task = await api('tasks', {...request,key:lastSubmission.key}); message('Task ' + task.id + ': ' + task.state); await refresh(); }
  catch(e) { message(e.message + '. Delivery may be unknown; refresh tasks before retrying. The same unchanged request retains its idempotency key.'); }
  finally { busy = false; el('submit').disabled = false; }
};
el('approve').onclick = async () => {
  if (!reviewed || busy) return;
  if (!confirm('Approve exactly ' + reviewed.task.action + ' ' + reviewed.task.target + ' at revision ' + reviewed.binding.revision + '?')) return;
  busy = true; el('approve').disabled = true; const binding = reviewed.binding; const fresh = reviewed.requiresFreshApproval; hideReview();
  try { await api(fresh ? 'approve':'execute',fresh ? binding : {taskId:binding.taskId,revision:binding.revision}); message('Approval accepted; execution is owned by the executor.'); await refresh(); }
  catch(e) { message(e.message + '. Refresh and review current state; do not replay an approval.'); }
  finally { busy = false; el('approve').disabled = false; }
};
el('refresh').onclick = () => refresh().catch(e => message(e.message));
el('cancel').onclick = hideReview;
el('logout').onclick = async () => {
  try { if (administrator) await api('logout',{}); } catch(e) { message(e.message); return; }
  credential = ''; lastSubmission = null; hideReview(); el('content').hidden = true; el('tasks').replaceChildren(); el('login').hidden = false; el('logout').hidden = true; message('Locked.');
};
`;

export function renderScript(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(browserScript);
}
