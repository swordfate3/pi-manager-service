import { approvalsPortalCss, approvalsPortalHtml, approvalsPortalJs } from "./approvals-portal.ts";
import { launchPortalCss, launchPortalHtml, launchPortalJs } from "./launch-portal.ts";
import { runtimePortalJs } from "./runtime-portal.ts";

export const portalHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi · 会话总览</title><link rel="stylesheet" href="/hub.css"><script src="/hub-management.js" defer></script><script src="/hub.js" defer></script></head>
<body><main><header><a class="brand" href="/sessions/" aria-label="Pi 会话首页"><span class="logo">π</span> Pi Web <span class="tag">HUB</span></a><span id="health" role="status">正在连接</span></header>
<section class="intro"><span class="eyebrow">你的工作，随时接续</span><h1>所有会话，一个入口。</h1><p>选择正在运行的 Pi，在手机与电脑之间继续工作。</p></section>
<section class="version-overview" aria-labelledby="versions-title"><div class="version-heading"><div><span class="eyebrow">SOFTWARE STATUS</span><h2 id="versions-title">版本与更新</h2></div><span id="version-summary" role="status">正在检查发布版本</span></div><div id="version-details" class="version-details"></div><p class="version-help">仅检查 Pi 与本 Web 扩展的公开发布版本，不自动安装或重启。会话版本为进程上报值，不等于磁盘已安装版本。构建不同不一定代表落后；其他扩展不在本次检查范围。</p></section>
<details class="management"><summary>运行管理 <span id="management-status" role="status">正在检查能力</span></summary><p>管理操作需要身份验证。重启只刷新选中的空闲 Pi；全局运行时更新由 Gate 评估精确稳定版本，两项操作彼此独立。</p><p id="management-help">正在检查管理登录方式…</p><form id="management-unlock" hidden><label for="management-code">一次性管理码</label><div class="controls"><input id="management-code" type="password" autocomplete="off" spellcheck="false" maxlength="32" placeholder="输入 32 位管理码" required><button type="submit">解锁管理</button></div></form><button id="management-gateway" type="button" hidden>使用网页登录解锁</button><button id="management-logout" type="button" hidden>锁定管理</button><p id="management-notice" role="status" aria-live="polite"></p>${launchPortalHtml}${approvalsPortalHtml}<section class="runtime-updates" aria-labelledby="runtime-update-title"><div class="runtime-update-heading"><h3 id="runtime-update-title">全局 Pi 运行时更新</h3><span id="runtime-update-status" role="status">正在检查能力</span></div><p>从官方发布目录选择精确稳定版本。目录只证明版本已发布，不代表兼容；Gate 会在提交后重新解析并隔离验证。此处创建更新任务；审批请使用上方统一授权中心。网页不会重建 Docker 镜像。</p><p id="runtime-update-policy"></p><div class="runtime-version-tools"><label for="runtime-version-search">搜索发布版本前缀</label><div class="controls"><input id="runtime-version-search" type="search" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="64" pattern="[0-9.]*" placeholder="例如 1.4"><button id="runtime-version-refresh" type="button">刷新目录与就绪状态</button></div></div><p id="runtime-version-catalog-status" role="status"></p><div id="runtime-version-list" class="runtime-version-list" role="listbox" aria-label="官方发布的稳定 Pi 版本"></div><button id="runtime-version-more" type="button" hidden>加载更早版本</button><p id="runtime-version-selected" class="runtime-version-selected"></p><div id="runtime-readiness" class="runtime-readiness" aria-live="polite"></div><form id="runtime-update-form"><label for="runtime-update-version">已选择的精确稳定版本</label><div class="controls"><input id="runtime-update-version" type="text" inputmode="text" autocomplete="off" spellcheck="false" maxlength="64" readonly required><button id="runtime-update-submit" type="submit" disabled>提交给 Gate</button></div></form><button id="runtime-update-query" type="button" hidden>按原任务编号查询</button><div id="runtime-update-results" aria-live="polite"></div></section><section class="restart-results" aria-label="进程重启结果"><div id="management-results" aria-live="polite"></div></section></details>
<section class="toolbar" aria-label="会话操作"><div><h2>在线会话 <span id="count">0</span></h2><p id="updated">等待登记</p></div><div class="controls"><label><span class="sr-only">搜索会话</span><input id="search" type="search" placeholder="搜索项目或会话…"></label><a id="new-pi-entry" class="open" href="#new-pi">新建 Pi</a><button id="refresh" type="button">刷新</button></div></section>
<div id="notice" role="status"></div><section id="sessions" class="grid" aria-label="在线 Pi 会话"></section>
<section id="empty" class="empty" hidden><span class="empty-icon">π</span><h3>还没有在线会话</h3><p>为 Pi 配置本总管的登记 socket 和独立凭据。<br>已启动的会话会自动出现在这里。</p></section>
<footer><span>每个会话独立连接 · 退出一个不影响其他会话</span><span>Pi Web Hub</span></footer></main></body></html>`;

export function renderPortalHtml(admin: boolean, chatUrl: string, managementUrl?: string) {
  const escapeHtml = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
  if (admin) return portalHtml.replace("<head>", `<head><meta name="pi-chat-origin" content="${escapeHtml(chatUrl)}">`);
  return portalHtml
    .replace(
      '<a id="new-pi-entry" class="open" href="#new-pi">新建 Pi</a>',
      managementUrl
        ? `<a class="open" href="${escapeHtml(managementUrl)}sessions/#new-pi" rel="noopener noreferrer">新建 Pi ↗</a>`
        : "",
    )
    .replace('<script src="/hub-management.js" defer></script>', "")
    .replace(
      /<details class="management">[\s\S]*?<\/details>/,
      managementUrl
        ? `<p class="management"><a href="${escapeHtml(managementUrl)}sessions/" rel="noopener noreferrer">打开运行管理 ↗</a></p>`
        : "",
    );
}

export const portalJs = `(() => {
  const get = (id) => document.getElementById(id);
  let items = [];
  let versions = { status: 'checking' };
  let loading = false;
  let refreshAgain = false;
  let lastRender = '';
  let navigationTimer;
  const resetNavigation = () => {
    clearTimeout(navigationTimer);
    for (const link of document.querySelectorAll('.open[aria-busy]')) {
      link.removeAttribute('aria-busy'); link.textContent = '打开会话 ↗';
    }
  };
  // Legacy launchers append a short run ID to the grant's project label.
  // Display-only: keep the original API label and capability route untouched.
  const projectLabel = (label) => label.replace(/ · [a-f0-9]{8}$/i, '').trim() || label;
  const element = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
  };
  const semver = (version) => {
    if (typeof version !== 'string' || version.length > 64 || !/^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$/.test(version)) return null;
    const parts = version.split('+')[0].split('.').map(Number); return parts.every(Number.isSafeInteger) ? parts : null;
  };
  function comparison(current, target, build) {
    if (!current) return { tone: 'unknown', text: '版本未上报' };
    if (!target) return { tone: 'unknown', text: '更新状态未知' };
    const a = semver(current.version); const b = semver(target.version);
    if (!a || !b) return { tone: 'unknown', text: '版本无法比较' };
    for (let i = 0; i < 3; i++) {
      if (a[i] < b[i]) return { tone: 'update', text: '可更新至 ' + target.version };
      if (a[i] > b[i]) return { tone: 'different', text: '高于发布版本' };
    }
    if (build) {
      if (!current.build || !target.build) return { tone: 'unknown', text: '构建未上报 · 无法确认一致' };
      if (current.build !== target.build) return { tone: 'different', text: '与发布构建不同' };
    }
    return { tone: 'current', text: '与发布版本一致' };
  }
  function versionLine(label, current, target, build) {
    const line = element('span', 'version-line', '');
    line.append(element('span', 'version-label', label));
    const value = element('span', 'version-value', current?.version || '未上报');
    if (current?.build) { value.textContent += ' · ' + current.build.slice(0, 8); value.title = '构建 SHA-256：' + current.build; }
    const result = label === 'Manager' && current && !target
      ? { tone: 'unknown', text: '发布源未配置' }
      : comparison(current, target, build);
    const badge = element('span', 'version-badge ' + result.tone, result.text);
    if (result.tone === 'different') badge.title = '构建或版本不同不证明落后，可能来自本地修改、其他分支或较新开发版本。';
    else if (result.tone === 'update') badge.title = label === 'Pi' ? '检测到较新的公开稳定版本；安装和进程刷新仍需独立的更新流程。' : '检测到较新的包版本；更新安装不代表运行中的扩展或 Hub 已重新加载。';
    line.append(value, badge);
    return line;
  }
  function renderVersions() {
    const known = versions.status === 'ok' || versions.status === 'partial';
    const targetPi = known ? versions.pi : undefined;
    const targetWeb = known ? versions.webUi : undefined;
    let updates = 0; let differences = 0;
    for (const session of items) {
      const pi = session.software?.piVersion || session.runtime?.version;
      const states = [comparison(pi ? { version: pi } : undefined, targetPi, false), comparison(session.software?.webUi, targetWeb, true)];
      if (states.some((s) => s.tone === 'update')) updates++;
      if (states.some((s) => s.tone === 'different')) differences++;
    }
    let status = versions.status === 'checking' ? '正在检查发布版本' : !known ? '发布检查不可用 · 更新状态未知' : versions.status === 'partial' ? '部分发布信息不可用' : '已检查公开发布版本';
    if (updates) status += ' · ' + updates + ' 个会话可更新';
    if (differences) status += ' · ' + differences + ' 个会话存在版本差异';
    const summary = get('version-summary'); summary.textContent = status;
    summary.className = 'version-summary' + (updates ? ' has-update' : '');
    const details = get('version-details'); details.replaceChildren();
    details.append(versionLine('Manager', versions.hub, undefined, true));
    details.append(element('span', 'release-target', '公开发布：Pi ' + (targetPi?.version || '未知') + ' / Web 扩展 ' + (targetWeb?.version || '未知') + (targetWeb?.build ? ' · ' + targetWeb.build.slice(0, 8) : '')));
    if (versions.checkedAt) details.append(element('span', 'release-target', '检查时间：' + new Date(versions.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · 发布检查最多每 5 分钟一次'));
  }
  function render() {
    const query = get('search').value.toLocaleLowerCase();
    const visible = items.filter((s) => projectLabel(s.label).toLocaleLowerCase().includes(query) || (s.sessionName || '未命名会话').toLocaleLowerCase().includes(query));
    get('notice').textContent = items.length && !visible.length ? '没有匹配的会话，请尝试其他关键词。' : '';
    const renderKey = JSON.stringify([items, query, versions]);
    if (renderKey === lastRender) return;
    lastRender = renderKey;
    renderVersions();
    get('sessions').replaceChildren();
    get('count').textContent = String(items.length);
    get('empty').hidden = items.length !== 0;
    for (const session of visible) {
      const card = document.createElement('article'); card.className = 'card';
      const top = document.createElement('div'); top.className = 'card-top';
      const icon = document.createElement('span'); icon.className = 'project-icon'; icon.textContent = '↗';
      const status = document.createElement('span'); status.className = 'online'; status.textContent = '在线';
      top.append(icon, status);
      const title = document.createElement('h3'); title.textContent = projectLabel(session.label); title.title = title.textContent;
      const meta = document.createElement('p'); meta.className = 'meta';
      const name = document.createElement('span'); name.className = 'session-name'; name.textContent = session.sessionName || '未命名会话'; name.title = name.textContent;
      const since = document.createElement('span'); since.textContent = ' · ' + new Date(session.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      meta.append(name, since);
      const known = versions.status === 'ok' || versions.status === 'partial';
      const software = element('span', 'version-lines', '');
      const piVersion = session.software?.piVersion || session.runtime?.version;
      software.append(versionLine('Pi', piVersion ? { version: piVersion } : undefined, known ? versions.pi : undefined, false));
      software.append(versionLine('Web 扩展', session.software?.webUi, known ? versions.webUi : undefined, true));
      if (session.runtime?.managed) software.append(element('span', 'runtime-note', '受管运行 · 重启资格需另行检查'));
      meta.append(software);
      const link = document.createElement('a'); link.className = 'open'; link.href = session.path; link.textContent = '打开会话 ↗';
      link.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        resetNavigation(); link.textContent = '正在打开…'; link.setAttribute('aria-busy', 'true');
        navigationTimer = setTimeout(resetNavigation, 10000);
      });
      card.append(top, title, meta, link); window.piHubManagement?.attach(card, session); get('sessions').append(card);
    }
  }
  async function refresh(afterCurrent = false) {
    if (loading) { if (afterCurrent) refreshAgain = true; return; } loading = true; get('refresh').disabled = true;
    try {
      const response = await fetch('/api/sessions', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const data = await response.json(); items = data.sessions; versions = data.versions || { status: 'unavailable' }; render();
      get('health').textContent = '● 总管已连接'; get('health').className = 'connected';
      get('updated').textContent = '刚刚更新 · 每 5 秒自动刷新';
    } catch {
      // Do not leave stale sessions looking online when the hub is unavailable.
      items = []; versions = { status: 'unavailable' }; render(); get('health').textContent = '连接中断'; get('health').className = 'disconnected';
      get('notice').textContent = '暂时无法连接总管。请检查服务，或点击刷新重试。';
    } finally {
      loading = false; get('refresh').disabled = false;
      if (refreshAgain) { refreshAgain = false; void refresh(); }
    }
  }
  window.addEventListener('pagehide', () => clearTimeout(navigationTimer));
  window.addEventListener('pageshow', (event) => {
    resetNavigation();
    if (event.persisted) refresh(true);
  });
  get('search').addEventListener('input', render); get('refresh').addEventListener('click', () => refresh(true));
  window.addEventListener('pi-hub-management', () => { lastRender = ''; render(); });
  refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
})();`;

export const portalManagementCss = `${launchPortalCss}${approvalsPortalCss}.management{border:1px solid #dce5d7;background:#ffffffa8;border-radius:14px;padding:16px 20px;margin:0 0 28px;font-size:13px;line-height:1.7}.management summary{cursor:pointer;font-weight:600}.management summary span{font-weight:400;color:#718076;margin-left:10px}.management p{color:#657768;margin:12px 0}.management form label,.runtime-version-tools label{display:block;margin-bottom:7px}.management .controls{flex-wrap:wrap}.management input{flex:1;max-width:360px;width:auto;min-width:0}.management button{min-height:42px}.management code{overflow-wrap:anywhere}.runtime-updates{border-top:1px solid #e1e7dd;margin-top:18px;padding-top:18px}.runtime-update-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.runtime-update-heading h3{font-size:14px;margin:0}.runtime-update-heading span,#runtime-update-policy,#runtime-version-catalog-status{color:#718076;font-size:12px}.runtime-version-tools{margin-top:16px}.runtime-version-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin:10px 0}.runtime-version-option{min-height:48px;text-align:left;background:#f7faf5;color:#415447}.runtime-version-option.selected{border-color:#668363;background:#eaf2e5;color:#294b36}.runtime-version-selected,.runtime-readiness{border:1px solid #e1e7dd;border-radius:10px;padding:10px 12px;background:#fbfcfa}.runtime-readiness{margin:12px 0}.runtime-readiness p{margin:5px 0}.runtime-readiness-consumer{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;overflow-wrap:anywhere}.runtime-update-result,.restart-result{border-top:1px solid #e1e7dd;padding:10px 0}.runtime-update-result p,.restart-result p{overflow-wrap:anywhere}.runtime-update-result .runtime-update-heading{color:#334c3d;font-weight:600}.runtime-update-identity,.runtime-update-target{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}.runtime-update-target{padding-left:12px;border-left:3px solid #e4ebe0}.restart{display:block;width:100%;margin-top:10px;background:transparent;color:#64795e;font-size:12px}.restart-result .open{width:fit-content}#management-notice{color:#97613c}@media(max-width:600px){.management{padding:14px 16px}.management input{width:100%;flex-basis:100%;max-width:none}.management summary span{display:block;margin-left:0}.management .controls button{width:100%}.runtime-version-list{grid-template-columns:1fr}.runtime-version-option{width:100%}}`;

/** Separate trusted Hub script: never served by an individual Pi backend. */
export const portalManagementJs = `(() => {
  const get = (id) => document.getElementById(id);
  get('new-pi-entry')?.addEventListener('click', () => { document.querySelector('details.management').open = true; });
  if (typeof location !== 'undefined' && location.hash === '#new-pi') document.querySelector('details.management').open = true;
  let auth = { available: false, authorized: false };
  let authGeneration = 0;
  let authTransition = false;
  const operations = new Map();
  let polling;
  const notice = (text) => { get('management-notice').textContent = text; };
  const changed = () => window.dispatchEvent(new Event('pi-hub-management'));
  async function api(route, value) {
    const generation = authGeneration;
    const current = () => { if (generation !== authGeneration) { const error = new Error('旧管理请求已失效'); error.stale = true; throw error; } };
    const response = await fetch('/api/management/' + route, { method: value === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(7000),
      headers: { 'Content-Type': 'application/json', ...(auth.csrf ? { 'X-Pi-Hub-Csrf': auth.csrf } : {}) }, body: value === undefined ? undefined : JSON.stringify(value) });
    current();
    if (!response.ok) {
      if (response.status === 401) { authGeneration++; auth.authorized = false; auth.csrf = undefined; runtimeUpdates.clearProtected(); approvals.clearProtected(); launchPi.clearProtected(); updateAuth(); }
      const error = new Error('管理请求未完成'); error.status = response.status; throw error;
    }
    const result = await response.json(); current(); return result;
  }
${runtimePortalJs}
${approvalsPortalJs}
${launchPortalJs}
  const restartAvailable = () => auth.restartAvailable ?? auth.available;
  function updateAuth() {
    get('management-status').textContent = authTransition ? '正在处理管理登录或锁定…' : !auth.available ? '未配置' : auth.authorized ? '已解锁 · 30 分钟有效' : '已锁定';
    const gateway = auth.authMode === 'gateway';
    get('management-unlock').hidden = gateway || !auth.available || auth.authorized || authTransition;
    get('management-gateway').hidden = !gateway || !auth.available || auth.authorized || authTransition;
    get('management-gateway').disabled = authTransition;
    get('management-code').disabled = authTransition;
    get('management-logout').hidden = !auth.authorized;
    get('management-logout').disabled = authTransition;
    get('management-help').textContent = !auth.available ? '本 Hub 尚未接入 Gate 管理能力。旧容器需使用新镜像重新启动一次，不能通过 /reload 获得受管能力。' : gateway ? '使用已验证的网页登录身份，无需管理码。管理会话 30 分钟有效；过期或锁定后可点击使用网页登录解锁。申请更新仍遵循 Gate 审批策略。' : '管理员在 Hub 的可信终端运行 pi-web-hub pair --config 配置文件，生成一次性管理码。管理授权与网页登录分开，过期后需重新解锁。';
    renderResults(); runtimeUpdates.updateAuth(); approvals.updateAuth(); launchPi.updateAuth();
    changed();
  }
  function save() {
    try { sessionStorage.setItem('pi-hub-restarts', JSON.stringify([...operations.values()].filter((o) => !o.done).map(({ id, generation, label }) => ({ id, generation, label })))); } catch {}
  }
  function renderResults() {
    get('management-results').replaceChildren();
    if (!auth.authorized) return;
    for (const op of operations.values()) {
      const row = document.createElement('div'); row.className = 'restart-result';
      const text = document.createElement('p');
      const labels = { pending: '等待管理员审批', queued: '已排队', running: '正在重启并核对原会话', succeeded: '已恢复原会话', failed: '失败，请检查后手动处理', recovery_required: '结果不确定，需要管理员检查', rejected: '已拒绝', stale: '身份或授权已变化' };
      text.textContent = op.label + ' · ' + (labels[op.status] || '结果未知，正在查询；不会重复执行') + (op.new_version ? ' · Pi ' + op.new_version : '');
      row.append(text);
      if (op.status === 'succeeded' && typeof op.path === 'string' && /^\\/s\\/${HUB_GENERATION_SOURCE}\\/$/.test(op.path)) {
        const link = document.createElement('a'); link.href = new URL(op.path, document.querySelector('meta[name="pi-chat-origin"]').content).href; link.className = 'open'; link.textContent = '打开恢复后的会话 ↗'; row.append(link);
      } else if (op.status === 'succeeded') {
        const unavailable = document.createElement('p'); unavailable.textContent = '重启已成功完成；当前恢复链接不可用（会话可能已继续、切换或退出）。请从在线会话列表选择当前会话。'; row.append(unavailable);
      }
      get('management-results').append(row);
    }
  }
  async function poll() {
    const generation = authGeneration;
    if (polling === generation || !auth.authorized || !restartAvailable()) return;
    polling = generation;
    try {
      for (const op of operations.values()) {
        if (op.done) continue;
        try {
          const result = await api('restarts/' + op.id);
          delete op.path;
          Object.assign(op, result);
          op.done = ['succeeded', 'failed', 'recovery_required', 'rejected', 'stale'].includes(op.status);
        } catch { if (generation !== authGeneration) return; op.status = 'unknown'; }
      }
      if (generation === authGeneration) { save(); renderResults(); }
    } finally { if (polling === generation) polling = undefined; }
  }
  window.piHubManagement = { attach(card, session) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'restart'; button.textContent = '重启 Pi · 应用已安装更新';
    button.disabled = !restartAvailable() || !auth.authorized || [...operations.values()].some((o) => o.generation === session.generation && !o.done);
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      let submitted = false;
      try {
        const target = await api('targets/' + session.generation);
        if (!target.managed) {
          notice(target.reason === 'source_evidence_unavailable'
            ? '缺少与当前运行内容和执行环境匹配的 Gate 兼容性验证证据；请先通过全局运行时更新完成验证。原进程未停止。'
            : '此容器不支持进程重启，请先用新镜像重新启动一次。');
          return;
        }
        if (target.mode === 'disabled') { notice('门禁尚未启用该能力，需要管理员配置独立生命周期策略。'); return; }
        if (!target.idle || target.pending || target.busy) { notice('此会话正在工作，或终端/未知命令使本进程无法证明可安全重启。工作完成后仍不可用时，需要在本地启动新的 Pi 进程；等待、取消和 /reload 不会清除输入不确定性。'); return; }
        if (!window.confirm('确认重启选中的 Pi？\\n项目：' + session.label + '\\n会话：' + (session.sessionName || '未命名') + '\\n当前 Pi：' + target.version + '\\n将加载已安装版本并恢复原会话及分支。网页会短暂断开；不会更新其他会话。' + (target.mode === 'manual' ? '\\n门禁仍需管理员审批。' : ''))) return;
        if (operations.size >= 64) { notice('本页操作记录已满，请重新打开管理页。'); return; }
        const id = [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, '0')).join('');
        const op = { id, generation: session.generation, label: session.label, status: 'unknown', done: false };
        operations.set(id, op); save(); renderResults(); submitted = true;
        try { Object.assign(op, await api('restarts', { generation: session.generation, runtimeId: target.runtime_id, sessionId: target.session_id, leafId: target.leaf_id, idempotencyKey: id })); }
        catch { notice('未收到提交结果，将按原操作编号查询。不要重新点击重启。'); }
        renderResults();
      } catch { notice('无法确认目标或授权已过期，请刷新管理状态后重试。'); }
      finally { if (!submitted) button.disabled = !restartAvailable() || !auth.authorized; }
    });
    card.append(button);
  } };
  async function loginWithGateway() {
    if (authTransition || auth.authMode !== 'gateway' || !auth.available || auth.authorized) return;
    authTransition = true; updateAuth();
    try { const result = await api('gateway', {}); authGeneration++; auth = { ...auth, ...result }; runtimeUpdates.clearProtected(); approvals.clearProtected(); launchPi.clearProtected(); updateAuth(); notice('已使用网页登录身份解锁管理，无需管理码。'); void poll(); void runtimeUpdates.poll(); void approvals.poll(); void launchPi.poll(); }
    catch (error) { if (!error.stale) notice('无法验证网页登录身份，请重新登录管理入口后重试；不会自动提交更新。'); }
    finally { authTransition = false; updateAuth(); }
  }
  get('management-gateway').addEventListener('click', loginWithGateway);
  get('management-unlock').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (authTransition || auth.authMode === 'gateway') return;
    const input = get('management-code'); const code = input.value.trim(); input.value = '';
    authTransition = true; updateAuth();
    try { const result = await api('unlock', { code }); authGeneration++; auth = { ...auth, ...result }; runtimeUpdates.clearProtected(); approvals.clearProtected(); launchPi.clearProtected(); updateAuth(); notice('管理已解锁。可独立选择进程重启或全局运行时更新。'); void poll(); void runtimeUpdates.poll(); void approvals.poll(); void launchPi.poll(); }
    catch (error) { if (!error.stale) notice('管理码无效、已使用或过期，请从可信终端重新获取。'); }
    finally { authTransition = false; updateAuth(); }
  });
  get('management-logout').addEventListener('click', async () => {
    if (authTransition) return;
    authTransition = true; updateAuth();
    try { await api('logout', {}); authGeneration++; auth.authorized = false; auth.csrf = undefined; runtimeUpdates.clearProtected(); approvals.clearProtected(); launchPi.clearProtected(); updateAuth(); notice('管理已锁定。已提交操作仍由门禁处理。'); }
    catch (error) { if (!error.stale) notice('锁定请求未完成，请关闭此页并让管理员撤销管理授权。'); }
    finally { authTransition = false; updateAuth(); }
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem('pi-hub-restarts') || '[]');
    if (Array.isArray(saved)) for (const o of saved.slice(0, 64)) if (/^[a-f0-9]{32}$/.test(o.id) && /^${HUB_GENERATION_SOURCE}$/.test(o.generation) && typeof o.label === 'string' && o.label.length <= 256) operations.set(o.id, { id: o.id, generation: o.generation, label: o.label, done: false, status: 'unknown' });
  } catch {}
  void (async () => { try { auth = await api('status'); updateAuth(); if (auth.authMode === 'gateway') await loginWithGateway(); await poll(); await runtimeUpdates.poll(); await approvals.poll(); await launchPi.poll(); } catch { notice('无法查询运行管理能力。'); } })();
  setInterval(async () => { await poll(); await runtimeUpdates.poll(); await approvals.poll(); await launchPi.poll(); }, 2000);
})();`;

export const portalCss = `:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#21312c;background:#f6f8f5;font-synthesis:none}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 90% 0,#e6efdf,transparent 55%)}main{max-width:1080px;margin:auto;padding:32px 40px 24px;min-height:100dvh}header{display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-size:20px;font-weight:650;color:inherit;text-decoration:none}.logo{display:grid;place-items:center;border-radius:12px;background:#234c3c;color:#e8f3dd;width:42px;height:42px;font:32px Georgia,serif}.tag{font-size:10px;letter-spacing:2px;color:#758478;border:1px solid #d7dfd5;border-radius:5px;padding:4px 6px}#health{font-size:12px;color:#697c70}.connected{color:#347652!important}.disconnected{color:#a35437!important}.intro{padding:48px 0 34px}.eyebrow{font-size:12px;letter-spacing:2px;color:#718478}h1{margin:14px 0 16px;font-size:clamp(30px,4vw,46px);font-weight:600;letter-spacing:-1.5px}.intro p{margin:0;color:#718076;font-size:15px;line-height:1.8}.toolbar{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:22px}h2{font-size:17px;font-weight:600;margin:0}#count{display:inline-grid;place-items:center;min-width:25px;height:23px;margin-left:8px;background:#e2ebe0;border-radius:7px;color:#476347;font-size:12px}#updated{font-size:12px;color:#879287;margin:8px 0 0}.controls{display:flex;gap:10px}input,button{font:inherit;border:1px solid #dce3d9;border-radius:9px;background:#fff;padding:11px 14px;font-size:13px;color:#415447}input{width:230px}button{cursor:pointer}button:hover{background:#eef3eb}button:disabled{opacity:.55}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #93ad91;outline-offset:3px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px}.card{display:flex;flex-direction:column;background:#ffffffdc;border:1px solid #e0e7dc;border-radius:16px;padding:24px;box-shadow:0 6px 24px #29412c04;min-width:0}.card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}.project-icon{display:grid;place-items:center;width:40px;height:40px;background:#edf3e8;color:#587452;border-radius:11px;font-size:23px}.online{font-size:11px;color:#39734e;background:#eff5eb;border-radius:20px;padding:5px 10px}.online:before{content:'●';font-size:8px;margin-right:5px}.card h3{font-size:18px;font-weight:600;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.meta{font-size:12px;color:#899587;margin:10px 0 20px;display:flex;flex-wrap:wrap;min-width:0;align-items:baseline}.session-name{max-width:calc(100% - 52px);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.card>.open{margin-top:auto}.meta>span:nth-child(2){flex-shrink:0}.version-lines{display:flex;flex-direction:column;gap:9px;flex-basis:100%;min-width:0;margin-top:18px;padding-top:16px;border-top:1px solid #edf0e9}.version-line{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;min-width:0;line-height:1.65}.version-label{font-weight:600;color:#64765f;min-width:48px}.version-value{color:#415447;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0}.version-badge{border-radius:6px;padding:2px 7px;font-size:10px;line-height:1.6;overflow-wrap:anywhere}.version-badge.current{color:#356044;background:#edf4e9}.version-badge.update{color:#8a531d;background:#fff1d7}.version-badge.different{color:#805d2f;background:#f6efe0}.version-badge.unknown{color:#778174;background:#f1f3ef}.runtime-note{font-size:10px;color:#879180}.version-overview{border:1px solid #dce5d7;border-radius:16px;padding:22px 24px;background:#ffffffa8;margin-bottom:20px}.version-heading{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.version-heading .eyebrow{font-size:9px;letter-spacing:1.5px}.version-heading h2{margin-top:6px}.version-summary{font-size:12px;color:#72816e;line-height:1.8}.version-summary.has-update{color:#8a531d}.version-details{display:flex;flex-direction:column;gap:10px;margin-top:18px;font-size:12px}.release-target{color:#7c8975;font-size:11px;line-height:1.8;overflow-wrap:anywhere}.version-help{font-size:11px;color:#7c8975;line-height:1.8;margin:14px 0 0;padding-top:12px;border-top:1px solid #e8eee3}.open{display:block;text-align:center;color:#365b42;background:#f2f6ee;border:1px solid #e4ebdf;text-decoration:none;border-radius:8px;padding:11px;font-size:13px}.open:hover{background:#e7efdf}.empty{text-align:center;border:1px dashed #d6dfd0;border-radius:16px;padding:55px 20px;background:#ffffff70}.empty-icon{font:44px Georgia,serif;color:#8a9e82}.empty h3{font-size:17px;font-weight:500;margin:18px 0 10px}.empty p{font-size:13px;color:#7a8978;line-height:1.9}#notice{font-size:13px;color:#a35c3d;line-height:1.6;margin-bottom:14px}#notice:empty{display:none}footer{display:flex;justify-content:space-between;gap:15px;border-top:1px solid #e0e6db;margin-top:48px;padding-top:20px;font-size:11px;color:#96a18f}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}@media(max-width:600px){main{padding:24px 20px}header{gap:8px}.brand{font-size:17px;gap:8px}.logo{width:36px;height:36px;font-size:27px}#health{font-size:11px}.intro{padding:48px 0 34px}h1{letter-spacing:-1px;line-height:1.35}.toolbar{flex-direction:column;align-items:stretch;gap:18px}.controls label{flex:1;min-width:0}input{width:100%;min-width:0}.grid{grid-template-columns:1fr}.card{padding:22px}.card-top{margin-bottom:18px}footer{flex-direction:column;margin-top:32px;line-height:1.6}}`;

import { HUB_GENERATION_SOURCE } from "../protocol/hub-generation.ts";
