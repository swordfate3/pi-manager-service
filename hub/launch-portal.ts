import { HUB_GENERATION_SOURCE } from "../protocol/hub-generation.ts";

export const launchPortalHtml = `<section id="new-pi" class="launch-section" aria-labelledby="launch-title"><div class="runtime-update-heading"><h3 id="launch-title">新建 Pi</h3><button id="launch-refresh" type="button">刷新启动状态</button></div><p>在允许的项目目录中新建独立 Pi。关闭网页不结束会话；不会创建或删除宿主文件夹。</p><p id="launch-status" role="status">解锁管理后可新建 Pi</p><div id="launch-picker" hidden><div class="controls"><button id="launch-root" type="button">gitproject 根目录</button><button id="launch-parent" type="button">上一级</button><button id="launch-more" type="button" hidden>更多文件夹</button></div><p id="launch-current" class="launch-path"></p><div id="launch-directories" class="launch-directories" aria-label="可选项目文件夹"></div><form id="launch-form"><label for="launch-name">会话名称</label><div class="controls"><input id="launch-name" type="text" autocomplete="off" maxlength="80" required><button id="launch-start" type="submit" disabled>在此目录启动 Pi</button></div></form></div><p id="launch-result" role="status" aria-live="polite"></p><button id="launch-again" type="button" hidden>再新建一个 Pi</button><div id="launch-jobs" aria-live="polite"></div></section>`;
export const launchPortalCss = `.launch-section{border-top:1px solid #dce5d7;margin-top:20px;padding-top:18px}.launch-path,.launch-job p{overflow-wrap:anywhere}.launch-path{padding:10px 12px;border:1px solid #dce5d7;border-radius:9px;background:#f7faf5;font-family:ui-monospace,monospace;font-size:12px}.launch-directories{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;max-height:260px;overflow:auto;margin:12px 0}.launch-directories button{text-align:left;overflow-wrap:anywhere}.launch-job{padding:12px;margin-top:12px;border:1px solid #dce5d7;border-radius:12px;background:#fbfcfa}.launch-job h4{margin:0}.launch-job p{margin:6px 0}.launch-job .open{display:inline-block;margin-top:6px}#launch-result{color:#815725}@media(max-width:600px){.launch-directories{grid-template-columns:1fr}.launch-section .controls{flex-direction:column;align-items:stretch}.launch-section .controls>*{width:100%;max-width:none}}`;

export const launchPortalJs = `
  const launchPi = (() => {
    let config, directory, jobs = [], loading, browsing = false, sequence = 0, sending = false, result = '', pending, known = false;
    const requestStorageKey = 'pi-hub-launch';
    const receiptStorageKey = 'pi-hub-launch-id';
    const node = (tag, text, cls = '') => { const el = document.createElement(tag); el.textContent = text; el.className = cls; return el; };
    const recovery = (value) => value && /^[a-f0-9]{32}$/.test(value.id) ? { id:value.id } : undefined;
    const readStored = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return undefined; } };
    const writeStored = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
    const removeStored = (key) => { try { sessionStorage.removeItem(key); return true; } catch { return false; } };
    pending = recovery(readStored(receiptStorageKey));
    let receiptDurable = !!pending;
    if (!pending) pending = recovery(readStored(requestStorageKey));
    const current = (generation) => generation === authGeneration && auth.authorized && !authTransition;
    const saveReceipt = () => { const receipt = recovery(pending); return !!receipt && writeStored(receiptStorageKey, receipt); };
    const clearStoredRecovery = () => removeStored(requestStorageKey) && removeStored(receiptStorageKey);
    const retainRecovery = () => { pending = recovery(pending); if (!pending) return; if (saveReceipt()) receiptDurable = true; if (receiptDurable) removeStored(requestStorageKey); };
    retainRecovery();
    function render() {
      get('launch-picker').hidden = !auth.authorized || !config?.enabled;
      get('launch-refresh').disabled = !auth.authorized || authTransition || loading === authGeneration;
      get('launch-start').disabled = !auth.authorized || authTransition || !config?.enabled || !directory || browsing || sending || !!pending;
      get('launch-parent').disabled = !current(authGeneration) || browsing || !directory || directory.parent === null;
      get('launch-root').disabled = !current(authGeneration) || browsing;
      get('launch-more').hidden = !directory?.truncated;
      get('launch-more').disabled = browsing || authTransition;
      get('launch-again').hidden = !auth.authorized || !pending || !known;
      get('launch-again').disabled = sending || authTransition;
      get('launch-status').textContent = !auth.authorized ? '解锁管理后可新建 Pi' : !auth.gateManagementAvailable ? '新建 Pi 尚未接入：需要配置 Gate 管理能力。' : config && !config.enabled ? '新建 Pi 尚未启用：需管理员一次性配置固定启动模板。' : !config ? '正在检查新建 Pi 能力…' : '仅允许在 ' + config.rootLabel + ' 下选择已有目录，当前上限 ' + config.maxActive + ' 个受管启动。';
      get('launch-result').textContent = auth.authorized ? result : '';
      get('launch-jobs').replaceChildren();
      if (!auth.authorized) return;
      const statuses = { queued:'已排队', starting:'正在启动', running:'Pi 已运行，等待会话登记', exited:'Pi 已退出', failed:'启动失败，请核对任务', recovery_required:'结果不确定，需管理员核对，不能盲目重试' };
      for (const job of jobs) {
        const row = node('article', '', 'launch-job'); row.append(node('h4', job.label), node('p', '目录：' + config?.rootLabel + '/' + job.path), node('p', statuses[job.status] || '结果未知'), node('p', '任务编号：' + job.id + ' · ' + job.stage));
        if (job.status === 'running' && typeof job.sessionUrl === 'string') {
          try {
            const chat = new URL(document.querySelector('meta[name="pi-chat-origin"]').content);
            const url = new URL(job.sessionUrl);
            if (url.origin === chat.origin && !url.username && !url.password && !url.search && !url.hash && new RegExp('^/s/${HUB_GENERATION_SOURCE}/$').test(url.pathname)) {
              row.children[2].textContent = '会话已登记，可以进入'; const link = node('a', '进入会话 ↗', 'open'); link.href = url.href; row.append(link);
            }
          } catch {}
        } else if (job.status === 'running' && Date.now() - job.updated_at > 60000) row.append(node('p', '登记等待较久：请检查 Web 扩展和 Hub 连接；不要重复创建来代替排查。'));
        get('launch-jobs').append(row);
      }
    }
    function renderDirectory() {
      get('launch-directories').replaceChildren();
      get('launch-current').textContent = directory ? config.rootLabel + (directory.path ? '/' + directory.path : '') : '';
      for (const entry of directory?.entries || []) {
        const button = node('button', '打开 ' + entry.name); button.type = 'button'; button.disabled = browsing || authTransition;
        button.addEventListener('click', () => browse(entry.path)); get('launch-directories').append(button);
      }
      render();
    }
    async function browse(path, cursor) {
      if (!auth.authorized || authTransition || !config?.enabled || browsing) return;
      const generation = authGeneration, ticket = ++sequence;
      browsing = true; renderDirectory();
      try {
        const query = new URLSearchParams({ path }); if (cursor) query.set('cursor', cursor);
        const next = await api('gate/workspaces?' + query);
        if (!current(generation) || ticket !== sequence) return;
        if (cursor && directory?.path === next.path && directory.revision === next.revision) next.entries = [...directory.entries, ...next.entries];
        directory = next;
        if (!get('launch-name').value) get('launch-name').value = path.split('/').pop() || config.rootLabel;
        result = '';
      } catch (error) {
        if (!current(generation) || error.stale || ticket !== sequence) return;
        directory = undefined; result = '文件夹不可用或已变化，请重新选择；不会自动创建或扩大目录范围。';
      } finally { if (ticket === sequence) { browsing = false; if (current(generation)) renderDirectory(); } }
    }
    async function poll() {
      if (!auth.authorized || authTransition || !auth.gateManagementAvailable || loading === authGeneration) { render(); return; }
      const generation = authGeneration; loading = generation; render();
      try {
        const next = await api('gate/launch-config'); if (!current(generation)) return;
        const previous = config; config = next;
        if (!config.enabled) { directory = undefined; jobs = []; renderDirectory(); return; }
        if (!previous) await browse(config.defaultPath);
        else if (previous.revision !== config.revision) { directory = undefined; result = '启动模板已变化，请重新选择目录并确认。'; renderDirectory(); }
        if (!current(generation)) return;
        const data = await api('gate/launches'); if (!current(generation)) return; jobs = data.jobs;
        if (pending) {
          try {
            const original = await api('gate/launches/' + pending.id); if (!current(generation)) return;
            known = true; if (!jobs.some((job) => job.id === original.id)) jobs.unshift(original);
          } catch (error) { if (!current(generation) || error.stale) return; known = false; result = '原启动任务尚未确认：' + pending.id + '。仅查询原编号，不会重复提交。'; }
        }
      } catch (error) { if (!current(generation) || error.stale) return; config = undefined; jobs = []; directory = undefined; renderDirectory(); result = '新建 Pi 服务暂不可用；没有重新提交任何启动。'; }
      finally { if (loading === generation) loading = undefined; if (current(generation)) render(); }
    }
    get('launch-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!current(authGeneration) || !config?.enabled || !directory || browsing || sending || pending) return;
      const label = get('launch-name').value.trim(); if (!label || label.length > 80 || /[\\p{Cc}\\p{Cs}]/u.test(label)) { result = '请输入不超过 80 字的有效会话名称。'; render(); return; }
      const generation = authGeneration;
      const selected = directory, profile = config;
      if (!window.confirm('在 ' + profile.rootLabel + '/' + selected.path + ' 新建 Pi？\\n名称：' + label + '\\n将使用固定容器配置。关闭网页不会停止 Pi。')) return;
      if (!current(generation) || directory !== selected || config !== profile) return;
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2,'0')).join('');
      const request = { id, path:selected.path, label, policy_revision:profile.revision, workspace_revision:selected.revision };
      pending = recovery(request); known = false; receiptDurable = saveReceipt();
      if (!receiptDurable || !writeStored(requestStorageKey, request)) { clearStoredRecovery(); pending = undefined; receiptDurable = false; result = '未启动：无法保存原任务编号，请恢复浏览器会话存储。'; render(); return; }
      sending = true; render();
      try {
        const job = await api('gate/launches', request); if (!current(generation)) return;
        known = true; jobs = [job, ...jobs.filter((row) => row.id !== job.id)]; result = '启动申请已记录：' + id + '。等待 Pi 运行并登记，不代表已可以聊天。';
      } catch (error) {
        if (!current(generation) || error.stale) return;
        if ([400,409].includes(error.status)) { pending = undefined; clearStoredRecovery(); receiptDurable = false; result = '目录或启动配置已变化，请刷新后重新选择并确认。'; }
        else result = '启动结果尚未确认：' + id + '。只查询原编号，不会自动重试。';
      } finally { sending = false; if (current(generation)) render(); }
    });
    get('launch-root').addEventListener('click', () => browse(''));
    get('launch-parent').addEventListener('click', () => directory?.parent !== null && directory && browse(directory.parent));
    get('launch-more').addEventListener('click', () => directory?.nextCursor && browse(directory.path, directory.nextCursor));
    get('launch-refresh').addEventListener('click', poll);
    get('launch-again').addEventListener('click', () => { if (!current(authGeneration) || sending || !known) return; const old = pending; if (!clearStoredRecovery()) { pending = old; result = '无法保存新的操作状态，未允许重复创建。'; } else { pending = undefined; receiptDurable = false; known = false; result = '请核对目录和名称，再确认启动另一个独立 Pi。'; } render(); });
    function clearProtected() { sequence++; browsing = false; retainRecovery(); config = undefined; directory = undefined; jobs = []; result = ''; known = false; get('launch-name').value = ''; renderDirectory(); }
    return { poll, updateAuth: render, clearProtected };
  })();
`;
