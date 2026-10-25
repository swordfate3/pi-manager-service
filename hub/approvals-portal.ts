export const approvalsPortalHtml = `<section id="approvals" class="approvals" aria-labelledby="approvals-title"><div class="runtime-update-heading"><h3 id="approvals-title">统一授权中心</h3><button id="approvals-refresh" type="button">刷新任务与回执</button></div><p id="approvals-status" role="status">解锁管理后可查看任务</p><p>批准仅代表允许 Gate 执行，不代表更新已经完成。请核对目标、版本和任务详情。自动模式仅适用于已登记的可信服务与镜像。</p><p id="approvals-result" role="status" aria-live="polite"></p><div id="approvals-receipts"></div><h4>Gate 任务</h4><div id="approvals-tasks"></div><h4>审批策略</h4><div id="approvals-policies"></div><h4>扩展授权</h4><p id="approvals-inbox-status" role="status"></p><div id="approvals-inbox"></div></section>`;
export const approvalsPortalCss = `.approvals{border-top:1px solid #dce5d7;margin-top:20px;padding-top:18px}.approvals h4{font-size:13px;margin:20px 0 10px}.approval-card{border:1px solid #dce5d7;border-radius:12px;background:#fbfcfa;padding:14px;margin:10px 0;overflow-wrap:anywhere;min-width:0}.approval-card h5{font-size:14px;margin:0 0 8px}.approval-identity{font:11px/1.8 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.approval-card pre{white-space:pre-wrap;font-size:11px;overflow-wrap:anywhere;max-height:240px;overflow:auto}.approval-card summary{font-size:12px}.approval-card .controls{margin-top:12px;flex-wrap:wrap}.approval-card select{font:inherit;padding:10px;max-width:100%;border:1px solid #dce5d7;border-radius:8px;background:white}.approval-card .danger{color:#99412f;border-color:#e8c4b9}.approval-inbox-link{margin:8px 0;text-align:left}#approvals-result{color:#815725}.approval-receipt{font-size:11px;overflow-wrap:anywhere}@media(max-width:600px){.approval-card{padding:12px}.approval-card .controls{flex-direction:column}.approval-card button,.approval-card select{width:100%}}`;

/** Embedded only in the trusted management script; uses its shared auth lifecycle. */
export const approvalsPortalJs = `
  const approvals = (() => {
    let tasks = [], policies = [], inbox = [], unavailable = 0, truncated = false;
    let loading, sending = false, result = '', failed = false;
    const pending = new Map();
    const taskCards = new Map(), policyCards = new Map();
    const storageKey = 'pi-hub-gate-decisions';
    const keyFor = (item, policy = false) => (policy ? 'policy:' : 'task:') + item.kind + ':' + item.id;
    const node = (tag, text, cls = '') => { const item = document.createElement(tag); item.textContent = text; item.className = cls; return item; };
    const actionLabel = (action) => ({ approve: '批准', reject: '拒绝', rollback: '回滚' })[action];
    const modeLabel = (mode) => ({ manual: 'manual · 手动审批', auto: 'auto · 自动执行', disabled: 'disabled · 禁用' })[mode];
    const persist = () => { try { sessionStorage.setItem(storageKey, JSON.stringify([...pending.values()])); return true; } catch { return false; } };
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || '[]');
      if (Array.isArray(saved)) for (const item of saved.slice(0,64)) {
        if (item && /^[a-f0-9]{32}$/.test(item.decision_id) && /^(task|policy):[a-z]+:[a-z0-9._-]{1,64}$/.test(item.key)) pending.set(item.decision_id, { decision_id: item.decision_id, key: item.key });
      }
    } catch {}
    const blocked = (key) => sending || authTransition || [...pending.values()].some((item) => item.key === key);
    function button(label, callback, disabled, danger = false) {
      const item = node('button', label, danger ? 'danger' : ''); item.type = 'button'; item.disabled = disabled; item.addEventListener('click', callback); return item;
    }
    function renderCards(id, items, cache, policy, create) {
      const container = get(id), keys = new Set(), rows = [];
      for (const item of items) {
        const key = keyFor(item, policy), model = JSON.stringify([authGeneration, item]);
        let card = cache.get(key);
        if (!card || card.model !== model) { card = { ...create(item), model }; cache.set(key, card); }
        keys.add(key); rows.push(card.row);
        for (const control of card.controls) control.disabled = blocked(key);
      }
      for (const key of cache.keys()) if (!keys.has(key)) cache.delete(key);
      // Leave unchanged nodes attached: polling must not reset details, drafts
      // or focus. Changed identities/content receive new closures and controls.
      const retained = new Set(rows);
      for (const child of [...container.children]) if (!retained.has(child)) container.removeChild(child);
      for (let index = 0; index < rows.length; index++) {
        if (container.children[index] !== rows[index]) container.insertBefore(rows[index], container.children[index] || null);
      }
    }
    function render() {
      for (const id of ['approvals-inbox','approvals-receipts']) get(id).replaceChildren();
      get('approvals-result').textContent = auth.authorized ? result : '';
      get('approvals-refresh').disabled = !auth.authorized || authTransition || loading === authGeneration;
      get('approvals-inbox-status').textContent = '';
      get('approvals-status').textContent = !auth.authorized ? '解锁管理后可查看任务' : !auth.gateManagementAvailable ? 'Gate 审批尚未接入：需管理员一次性配置专用凭据；扩展审核独立可用。' : failed ? 'Gate 暂不可用；已清除旧任务显示，未执行任何操作。' : loading === authGeneration ? '正在核对任务…' : tasks.length + ' 个任务 · Gate 独立执行';
      if (!auth.authorized) {
        tasks = []; policies = []; inbox = []; unavailable = 0; truncated = false; result = ''; failed = false;
        taskCards.clear(); policyCards.clear();
        get('approvals-tasks').replaceChildren(); get('approvals-policies').replaceChildren();
        return;
      }
      for (const item of pending.values()) get('approvals-receipts').append(node('p', '未确认回执：' + item.decision_id + '。仅查询原编号，不会重复发送；未确认前该对象不能再次操作。', 'approval-receipt'));
      renderCards('approvals-tasks', tasks, taskCards, false, (item) => {
        const row = node('article', '', 'approval-card');
        row.append(node('h5', item.title), node('p', item.target + ' · ' + item.status + ' / ' + item.stage));
        row.append(node('p', '任务编号：' + item.id + (item.version ? ' · 版本：' + item.version : ''), 'approval-identity'));
        const details = node('details', ''); details.append(node('summary', '查看精确任务详情'));
        details.append(node('pre', JSON.stringify({ kind:item.kind, target:item.target, revision:item.revision, version:item.version, commit:item.commit, image:item.image, plan_hash:item.plan_hash, details:item.details }, null, 2)));
        row.append(details);
        const controls = node('div', '', 'controls');
        for (const action of item.actions || []) {
          if (!actionLabel(action)) continue;
          controls.append(button(actionLabel(action), () => decide(item, action), blocked(keyFor(item)), action !== 'approve'));
        }
        row.append(controls); return { row, controls: [...controls.children] };
      });
      renderCards('approvals-policies', policies, policyCards, true, (item) => {
        const row = node('article', '', 'approval-card'); row.append(node('h5', item.kind + ' / ' + item.id));
        row.append(node('p', '当前策略：' + modeLabel(item.mode) + (item.paused ? ' · 已暂停' : '')));
        row.append(node('p', '可信镜像：' + (item.images?.join(', ') || '由已登记的服务定义管理'), 'approval-identity'));
        const controls = node('div', '', 'controls');
        const select = node('select', ''); select.id = 'approvals-policy-' + item.kind + '-' + item.id; select.setAttribute?.('aria-label', item.id + ' 审批模式');
        for (const mode of ['manual','auto','disabled']) { const option = node('option', modeLabel(mode)); option.value = mode; select.append(option); }
        select.value = item.mode; select.disabled = blocked(keyFor(item, true)); controls.append(select);
        controls.append(button('保存策略', () => changePolicy(item, select.value), blocked(keyFor(item, true))));
        if (item.kind === 'service' && item.paused) controls.append(button('恢复服务审批', () => resume(item), blocked(keyFor(item, true))));
        row.append(controls); return { row, controls: [...controls.children] };
      });
      get('approvals-inbox-status').textContent = !auth.interactionsAvailable ? '扩展授权收件箱未配置' : inbox.length + ' 个待审核请求' + (unavailable ? ' · ' + unavailable + ' 个来源暂不可用，不能视为空' : '') + (truncated ? ' · 已达显示上限' : '');
      for (const item of inbox) {
        if (!/^\\/interactions\\/[a-f0-9-]{32,64}\\/[a-f0-9]{32}\\/$/.test(item.path) || item.deadline <= Date.now()) continue;
        const link = node('a', item.adapterId + ' · ' + item.action + ' · 查看并授权 ↗', 'open approval-inbox-link'); link.href = item.path; get('approvals-inbox').append(link);
      }
    }
    async function reconcile() {
      const generation = authGeneration;
      for (const item of [...pending.values()]) {
        try {
          const receipt = await api('gate/decisions/' + item.decision_id);
          if (generation !== authGeneration || !auth.authorized) return;
          if (receipt.decision_id === item.decision_id && receipt.status === 'recorded') {
            pending.delete(item.decision_id); persist(); result = '审批决定已记录：' + item.decision_id + '。请刷新任务核对执行状态，不代表执行已完成。';
          } else result = '原决定投递结果未确认；不会自动重试。请保留编号由管理员核对。';
        } catch (error) {
          if (generation !== authGeneration || error.stale) return;
          result = '原决定回执未确认；不会重新提交。请刷新查询或由管理员核对。';
        }
      }
    }
    async function submit(route, body, key, confirmation) {
      if (!auth.authorized || !auth.gateManagementAvailable || blocked(key)) return;
      const generation = authGeneration;
      if (!window.confirm(confirmation)) return;
      if (generation !== authGeneration || !auth.authorized || authTransition) return;
      if (pending.size >= 64) { result = '未确认回执已满，请先核对旧决定。'; render(); return; }
      const decision_id = [...crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2,'0')).join('');
      pending.set(decision_id, { decision_id, key });
      if (!persist()) { pending.delete(decision_id); result = '未提交：无法保存原决定编号，请恢复浏览器会话存储。'; render(); return; }
      sending = true; render();
      try {
        const receipt = await api('gate/' + route, { ...body, decision_id });
        if (generation !== authGeneration) return;
        if (receipt.decision_id === decision_id && receipt.status === 'recorded') {
          pending.delete(decision_id); persist(); result = '审批决定已记录：' + decision_id + '。执行状态请刷新核对。';
        } else result = '投递未确认；仅按原决定编号查询，不会重新提交。';
      } catch (error) {
        if (generation !== authGeneration || error.stale) return;
        if ([400,409].includes(error.status)) { pending.delete(decision_id); persist(); result = '任务或策略已变化 / 请求被拒绝；请刷新并重新审阅，不会自动批准新内容。'; }
        else result = '投递未确认；保留原决定编号，仅查询不重发。';
      } finally { sending = false; if (generation === authGeneration) render(); }
    }
    function decide(item, action) {
      return submit('decisions', { kind:item.kind, id:item.id, revision:item.revision, action }, keyFor(item),
        '确认' + actionLabel(action) + '此任务？\\n目标：' + item.target + '\\n任务：' + item.title + '\\n编号：' + item.id + '\\n版本：' + (item.version || '—') + '\\n提交：' + (item.commit || '—') + '\\n镜像：' + (item.image || '—') + '\\n计划：' + (item.plan_hash || '—') + '\\n审阅版本：' + item.revision + '\\n详情：' + JSON.stringify(item.details || {}) + '\\n批准只授予 Gate 执行权限；回滚也可能短暂断连。');
    }
    function changePolicy(item, mode) {
      if (!['manual','auto','disabled'].includes(mode) || mode === item.mode) return;
      return submit('policies', { kind:item.kind, id:item.id, revision:item.revision, mode }, keyFor(item,true),
        '确认修改 ' + item.kind + '/' + item.id + ' 为 ' + mode + '？\\nauto 会自动处理该范围内后续的合规任务；不会扩充可信镜像列表。\\n审阅版本：' + item.revision);
    }
    function resume(item) { return submit('resume', { id:item.id, revision:item.revision }, keyFor(item,true), '确认恢复 ' + item.id + ' 的审批处理？\\n现有策略：' + item.mode + '\\n审阅版本：' + item.revision); }
    async function poll() {
      const generation = authGeneration;
      if (loading === generation || !auth.authorized || authTransition) return;
      loading = generation; render();
      try {
        if (auth.gateManagementAvailable) {
          try {
            await reconcile();
            if (generation !== authGeneration || !auth.authorized) return;
            const data = await api('gate');
            if (generation !== authGeneration) return;
            tasks = Array.isArray(data.tasks) ? data.tasks.slice(0,512) : []; policies = Array.isArray(data.policies) ? data.policies.slice(0,128) : []; failed = false;
          } catch (error) { if (generation !== authGeneration || error.stale) return; tasks = []; policies = []; failed = true; }
        }
        if (auth.interactionsAvailable) {
          try {
            const data = await api('interactions'); if (generation !== authGeneration) return;
            inbox = Array.isArray(data.items) ? data.items.slice(0,64) : []; unavailable = data.unavailable || 0; truncated = !!data.truncated;
          } catch (error) { if (generation !== authGeneration || error.stale) return; inbox = []; unavailable = 1; }
        }
      } finally { if (loading === generation) loading = undefined; if (generation === authGeneration) render(); }
    }
    function clearProtected() { tasks = []; policies = []; inbox = []; unavailable = 0; truncated = false; result = ''; failed = false; taskCards.clear(); policyCards.clear(); render(); }
    get('approvals-refresh').addEventListener('click', poll);
    return { poll, updateAuth: render, clearProtected };
  })();
`;
