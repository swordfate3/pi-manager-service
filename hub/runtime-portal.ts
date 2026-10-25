/** Browser source injected into the trusted management portal script. */
export const runtimePortalJs = String.raw`
  const runtimeUpdates = (() => {
    const storageKey = 'pi-hub-runtime-update';
    const terminalStatuses = new Set(['succeeded', 'failed', 'recovery_required', 'rejected', 'stale']);
    const activeStatuses = new Set(['pending', 'queued', 'running']);
    const jobs = new Map();
    let policy;
    let pending;
    let uncertain = false;
    let polling;
    let submitting = false;
    let catalogState;
    let catalogVersions = [];
    let nextCursor;
    let selectedVersion;
    let readinessState;
    let catalogLoading = false;
    let readinessLoading = false;
    let catalogSequence = 0;
    let readinessSequence = 0;
    const stableVersion = (value) => typeof value === 'string' && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(value);
    const validId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
    function directionLabel(version) {
      const installed = readinessState?.status !== 'unavailable' && readinessState?.installed_version;
      if (!stableVersion(installed) || !stableVersion(version)) return '更新方向未知（共享已安装版本不可用）';
      const current = installed.split('.').map(BigInt);
      const target = version.split('.').map(BigInt);
      let direction = '同版本更新';
      for (let i = 0; i < 3; i++) {
        if (target[i] === current[i]) continue;
        direction = target[i] > current[i] ? '升级' : '降级';
        break;
      }
      return direction + '：共享 Pi ' + installed + ' → ' + version +
        (direction === '降级' ? '。停止原进程前必须通过会话兼容性验证；不兼容时保留原进程与历史。' : '。');
    }
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (saved && validId(saved.id) && stableVersion(saved.version)) pending = { id: saved.id, version: saved.version };
    } catch {}
    function configured() { return auth.runtimeUpdatesAvailable === true; }
    function savePending() {
      try {
        if (pending) {
          const value = JSON.stringify({ id: pending.id, version: pending.version });
          sessionStorage.setItem(storageKey, value);
          return sessionStorage.getItem(storageKey) === value;
        }
        sessionStorage.removeItem(storageKey);
        return sessionStorage.getItem(storageKey) === null;
      } catch { return false; }
    }
    function clearPending() { pending = undefined; uncertain = false; savePending(); }
    function isJob(value) {
      return value && validId(value.id) && stableVersion(value.version) && typeof value.status === 'string' && typeof value.stage === 'string' && Array.isArray(value.targets);
    }
    function remember(value) {
      if (!isJob(value)) return;
      jobs.set(value.id, value);
      if (pending?.id === value.id && terminalStatuses.has(value.status)) clearPending();
    }
    const stageLabel = (stage) => ({
      awaiting_approval: '等待宿主机审批', queued_by_policy: '按策略排队', approved_by_host: '宿主机已批准', policy_changed: '策略已变更',
      resolving: '正在解析已发布候选版本', validating: '正在隔离验证；在线进程尚未改变',
      preparing: '准备安装', prepared: '安装准备完成', activating: '正在激活新版本', refreshing: '正在刷新受管 Pi 进程',
      waiting_for_idle: '等待忙碌目标空闲', waiting_for_consumer_readiness: '等待共享运行时使用者就绪',
      unmanaged_or_unavailable_consumer: '存在未受管或不可用的共享运行时使用者，需要迁移或检查',
      install_failed: '安装失败', installation_outcome_unknown: '安装结果不确定，需要管理员检查',
      refresh_requires_inspection: '刷新结果需要管理员检查', incompatible_candidate: '候选版本不兼容',
      restore_pre_stop_failed: '会话恢复验证未通过；原进程未停止',
      incompatible_session: '当前会话不兼容', candidate_changed: '候选包内容已变化，需要重新解析并审批',
      protocol_unavailable: '运行时刷新协议不可用', complete: '任务已完成',
    })[stage] || String(stage || 'unknown').replaceAll('_', ' ');
    const statusLabel = (status) => ({
      pending: '等待处理', queued: '已排队', running: '任务进行中', succeeded: '安装成功；所有受管 Pi 进程已刷新或退出', failed: '安装失败',
      recovery_required: '结果不确定，需要管理员检查', rejected: '任务已拒绝', stale: '任务已过期',
    })[status] || '结果未知';
    const targetLabel = (status) => ({
      waiting_for_idle: '等待目标空闲', refreshing: '正在刷新 Pi 进程', succeeded: '已加载新版本', exited: '已退出',
      validating_source: '正在核验新进程', blocked: '已阻止刷新',
    })[status] || String(status || 'unknown').replaceAll('_', ' ');
    const reasonLabel = (reason) => ({
      consumer_not_ready: '共享运行时使用者尚未就绪', awaiting_state_change: '等待运行状态变化', busy_race: '空闲确认期间再次忙碌',
      busy_waits_for_idle: '正在生成；允许提交，执行时等待空闲',
      target_source_validation: '正在完成实际运行内容的兼容性验证',
      restore_pre_stop_failed: '会话恢复验证未通过；原进程未停止',
      protocol_unavailable: '运行时刷新协议不可用', legacy_supervisor: '旧版监管协议，需要迁移后才能受管',
      incompatible_candidate: '候选版本不兼容', incompatible_session: '当前会话不兼容', candidate_changed: '候选包内容已变化',
    })[reason] || String(reason || '').replaceAll('_', ' ');
    function renderJob(value) {
      const row = document.createElement('div'); row.className = 'runtime-update-result';
      const heading = document.createElement('p'); heading.className = 'runtime-update-heading';
      heading.textContent = 'Pi ' + value.version + ' · ' + statusLabel(value.status);
      const identity = document.createElement('p'); identity.className = 'runtime-update-identity'; identity.textContent = '任务编号：' + value.id;
      const stage = document.createElement('p'); stage.textContent = '阶段：' + stageLabel(value.stage);
      row.append(heading, identity, stage);
      if (value.status === 'pending' && policy?.mode === 'manual') {
        const approval = document.createElement('p'); approval.textContent = auth.gateManagementAvailable ? '手动策略：请在上方「统一授权中心」核对并批准此任务。' : '手动策略：请在主机使用 runtime-approve ' + value.id + ' 批准；统一授权中心尚未配置。'; row.append(approval);
      }
      if (value.status === 'recovery_required' && value.resolved !== true) {
        const unresolved = document.createElement('p'); unresolved.textContent = '此结果尚未解决，将阻止新的运行时更新任务；需要管理员检查并在 Gate 侧解决，本页面不会自动解决。'; row.append(unresolved);
      }
      const visibleTargets = [];
      for (const target of value.targets) if (target?.status !== 'exited' && visibleTargets.length < 128) visibleTargets.push(target);
      for (const target of value.targets) if (target?.status === 'exited' && visibleTargets.length < 128) visibleTargets.push(target);
      if (value.targets.length > 128) {
        const limit = document.createElement('p'); limit.textContent = '共' + value.targets.length + '个目标记录，仅显示前128条'; row.append(limit);
      }
      for (const target of visibleTargets) {
        if (!target || !validId(target.run_id) || typeof target.status !== 'string') continue;
        const line = document.createElement('p'); line.className = 'runtime-update-target';
        let text = '目标 ' + target.run_id + ' · ' + targetLabel(target.status);
        if (typeof target.old_version === 'string') text += ' · 原版本 ' + target.old_version;
        if (typeof target.version === 'string') text += ' · 当前版本 ' + target.version;
        if (['waiting_for_idle', 'validating_source', 'blocked'].includes(target.status) && typeof target.wait_reason === 'string') text += ' · ' + reasonLabel(target.wait_reason);
        line.textContent = text; row.append(line);
      }
      return row;
    }
    function validCatalog(value) {
      return value && ['fresh', 'stale', 'unavailable'].includes(value.status) && Array.isArray(value.versions) && value.versions.length <= 50 && value.versions.every((entry) => entry && stableVersion(entry.version)) && (value.next_cursor === undefined || (typeof value.next_cursor === 'string' && value.next_cursor.length > 0 && value.next_cursor.length <= 256));
    }
    function validReadiness(value) {
      return value && ['ready', 'blocked', 'unavailable'].includes(value.status) && Array.isArray(value.consumers) && value.consumers.length <= 128 && value.consumers.every((consumer) => consumer && validId(consumer.run_id) && typeof consumer.ready === 'boolean' && (consumer.version === undefined || stableVersion(consumer.version)) && (consumer.reason === undefined || /^[a-z_]{1,64}$/.test(consumer.reason))) && (value.installed_version === undefined || stableVersion(value.installed_version));
    }
    function renderCatalog() {
      const status = get('runtime-version-catalog-status');
      const list = get('runtime-version-list');
      const selected = get('runtime-version-selected');
      const more = get('runtime-version-more');
      list.replaceChildren(); more.hidden = true;
      if (!configured()) status.textContent = '发布版本目录未配置';
      else if (!auth.authorized) status.textContent = '解锁管理后可查看官方发布版本目录';
      else if (catalogLoading) status.textContent = '正在查询官方发布版本目录…';
      else if (!catalogState) status.textContent = '尚未查询官方发布版本目录';
      else if (catalogState.status === 'unavailable') status.textContent = '官方发布版本目录暂时不可用；这与 Gate 更新策略禁用不同。';
      else if (catalogState.status === 'stale') status.textContent = '正在显示陈旧缓存目录；可浏览，但提交时 Gate 仍会重新检查精确版本与完整性。';
      else status.textContent = '官方发布版本目录已刷新；发布不代表已经验证兼容。';
      if (auth.authorized && catalogState?.checked_at) status.textContent += ' 检查时间：' + new Date(catalogState.checked_at).toLocaleString();
      if (!auth.authorized || !configured()) {
        selected.textContent = '';
        return;
      }
      for (const version of catalogVersions) {
        const option = document.createElement('button'); option.type = 'button';
        option.className = 'runtime-version-option' + (selectedVersion === version ? ' selected' : '');
        option.textContent = 'Pi ' + version + ' · 已发布 / 未验证';
        option.addEventListener('click', () => { selectedVersion = version; get('runtime-update-version').value = version; render(); });
        list.append(option);
      }
      more.hidden = !nextCursor || catalogLoading;
      if (selectedVersion) selected.textContent = '已选择 Pi ' + selectedVersion + ' · 已发布 / 未验证。' + directionLabel(selectedVersion) + '兼容性仍未知；Gate 会在提交后隔离验证，当前在线进程不会因选择而改变。';
      else selected.textContent = catalogState?.status === 'unavailable' ? '目录不可用，当前没有可提交的发布版本。' : '请选择一个已发布的精确稳定版本。';
    }
    function renderReadiness() {
      const node = get('runtime-readiness'); node.replaceChildren();
      if (!configured() || !auth.authorized) return;
      const summary = document.createElement('p');
      if (readinessLoading) summary.textContent = '正在查询当前共享运行时与受管进程就绪状态…';
      else if (!readinessState || readinessState.status === 'unavailable') summary.textContent = '当前运行时就绪状态不可用；这不表示兼容或已获授权。';
      else {
        const installed = readinessState.installed_version ? 'Pi ' + readinessState.installed_version : '未知';
        summary.textContent = '当前共享已安装版本：' + installed + ' · ' + (readinessState.status === 'ready' ? '所有已报告使用者当前就绪' : '存在阻止项；Gate 会在执行时重新清点');
      }
      node.append(summary);
      for (const consumer of readinessState?.consumers || []) {
        const line = document.createElement('p'); line.className = 'runtime-readiness-consumer';
        line.textContent = '使用者 ' + consumer.run_id + ' · Pi ' + (consumer.version || '未知') + ' · ' + (consumer.ready ? '当前就绪' : '阻止 / 未就绪') + (consumer.reason ? ' · ' + reasonLabel(consumer.reason) : '');
        node.append(line);
      }
    }
    function render() {
      const status = get('runtime-update-status');
      const policyNode = get('runtime-update-policy');
      const results = get('runtime-update-results');
      const query = get('runtime-update-query');
      results.replaceChildren(); query.hidden = true;
      if (!configured()) status.textContent = '运行时更新未配置';
      else if (!auth.authorized) status.textContent = '解锁管理后可提交运行时更新';
      else if (!policy) status.textContent = '正在查询运行时更新策略';
      else if (policy.mode === 'disabled') status.textContent = '运行时更新策略已禁用';
      else status.textContent = '运行时更新已就绪';
      policyNode.textContent = !policy ? '' : policy.mode === 'manual' ? '策略：手动审批（manual）' : policy.mode === 'auto' ? '策略：自动执行（auto）' : '策略：已禁用（disabled）';
      renderCatalog(); renderReadiness();
      if (!auth.authorized) {
        policyNode.textContent = '';
        get('runtime-update-submit').disabled = true;
        return;
      }
      for (const value of jobs.values()) results.append(renderJob(value));
      if (pending && !jobs.has(pending.id)) {
        const unknown = document.createElement('div'); unknown.className = 'runtime-update-result';
        const summary = document.createElement('p'); summary.textContent = 'Pi ' + pending.version + ' · 结果不确定，尚未找到任务；不会重新提交。';
        const identity = document.createElement('p'); identity.textContent = '任务编号：' + pending.id; unknown.append(summary, identity); results.append(unknown);
        query.hidden = !uncertain;
      }
      const active = [...jobs.values()].some((value) => activeStatuses.has(value.status) || (value.status === 'recovery_required' && value.resolved !== true));
      const exactSelection = stableVersion(selectedVersion) && get('runtime-update-version').value.trim() === selectedVersion;
      get('runtime-update-submit').disabled = authTransition || !configured() || !policy || policy.mode === 'disabled' || catalogState?.status === 'unavailable' || readinessState?.status !== 'ready' || !exactSelection || active || !!pending || submitting;
    }
    async function lookupPending() {
      if (!pending || !auth.authorized || !configured()) return;
      const generation = authGeneration;
      const identity = pending;
      try {
        const result = await api('runtime-updates/' + identity.id);
        if (generation !== authGeneration || pending !== identity) return;
        if (isJob(result) && result.id === identity.id && result.version === identity.version) { uncertain = false; remember(result); }
        else { uncertain = true; notice('任务查询响应不完整；将保留原任务编号继续查询，不会重新提交。'); }
      } catch (error) {
        if (generation !== authGeneration || pending !== identity) return;
        uncertain = true;
        if (error.status !== 404) notice('暂时无法确认运行时更新任务；请保留任务编号并稍后按原编号查询。');
      }
      render();
    }
    async function refreshCatalog(reset) {
      if (!auth.authorized || !configured()) return;
      const query = get('runtime-version-search').value.trim();
      if (query.length > 64 || !/^[0-9.]*$/.test(query)) {
        notice('版本搜索只接受最多 64 个数字或点。');
        return;
      }
      const cursor = reset ? '' : nextCursor || '';
      if (!reset && !cursor) return;
      const generation = authGeneration;
      const sequence = ++catalogSequence;
      catalogLoading = true; render();
      try {
        const result = await api('runtime-versions?query=' + encodeURIComponent(query) + '&cursor=' + encodeURIComponent(cursor));
        if (generation !== authGeneration || sequence !== catalogSequence) return;
        if (!validCatalog(result)) throw new Error('invalid catalog');
        catalogState = result;
        const versions = result.versions.map((entry) => entry.version);
        catalogVersions = reset ? versions : [...new Set([...catalogVersions, ...versions])].slice(-100);
        nextCursor = result.next_cursor;
        if (result.status === 'unavailable') {
          catalogVersions = [];
          selectedVersion = undefined;
          get('runtime-update-version').value = '';
        } else if (!selectedVersion && catalogVersions.length) {
          selectedVersion = catalogVersions[0];
          get('runtime-update-version').value = selectedVersion;
        }
      } catch (error) {
        if (generation !== authGeneration || sequence !== catalogSequence || error.stale) return;
        catalogState = { status: 'unavailable', versions: [] };
        catalogVersions = []; nextCursor = undefined; selectedVersion = undefined; get('runtime-update-version').value = '';
      } finally {
        if (generation === authGeneration && sequence === catalogSequence) { catalogLoading = false; render(); }
      }
    }
    async function refreshReadiness() {
      if (!auth.authorized || !configured()) return;
      const generation = authGeneration;
      const sequence = ++readinessSequence;
      readinessLoading = true; render();
      try {
        const result = await api('runtime-readiness');
        if (generation !== authGeneration || sequence !== readinessSequence) return;
        readinessState = validReadiness(result) ? result : { status: 'unavailable', consumers: [] };
      } catch (error) {
        if (generation !== authGeneration || sequence !== readinessSequence || error.stale) return;
        readinessState = { status: 'unavailable', consumers: [] };
      } finally {
        if (generation === authGeneration && sequence === readinessSequence) { readinessLoading = false; render(); }
      }
    }
    async function poll() {
      const generation = authGeneration;
      if (polling === generation || !auth.authorized || !configured()) return;
      polling = generation;
      try {
        const result = await api('runtime-updates');
        if (generation !== authGeneration) return;
        policy = result?.policy && ['manual', 'auto', 'disabled'].includes(result.policy.mode) ? { mode: result.policy.mode } : undefined;
        jobs.clear();
        for (const value of [...(Array.isArray(result?.jobs) ? result.jobs : []), ...(Array.isArray(result?.active) ? result.active : [])].slice(0, 128)) remember(value);
        if (pending && !jobs.has(pending.id)) await lookupPending();
        if (!catalogState) await refreshCatalog(true);
        await refreshReadiness();
      } catch { if (generation === authGeneration) notice('暂时无法查询运行时更新状态。'); }
      finally { if (polling === generation) polling = undefined; if (generation === authGeneration) render(); }
    }
    get('runtime-update-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (get('runtime-update-submit').disabled) return;
      const version = get('runtime-update-version').value.trim();
      if (!stableVersion(version)) { notice('请输入精确稳定版本，例如 1.3.0；不接受 latest、范围、预发布版或构建标记。'); return; }
      if (version !== selectedVersion) { notice('请先从官方发布目录选择要提交的精确稳定版本。'); return; }
      const manual = policy?.mode === 'manual' ? (auth.gateManagementAvailable ? '\n当前是手动策略；提交后请在统一授权中心审阅并批准。' : '\n当前是手动策略；提交后仍需主机管理员使用 runtime-approve 批准。') : '';
      const blockers = (readinessState?.consumers || []).filter((consumer) => !consumer.ready).slice(0, 5);
      const blockerText = blockers.length ? '\n当前已知阻止项（执行时 Gate 会重新清点）：\n' + blockers.map((consumer) => consumer.run_id + ' · ' + reasonLabel(consumer.reason || 'consumer_not_ready')).join('\n') : '';
      if (!window.confirm('确认向 Gate 提交 Pi ' + version + ' 的全局运行时更新任务？\n' + directionLabel(version) + '\n该版本已发布，但兼容性尚未验证；Gate 将先进行隔离验证，选择本身不会改变在线进程。\n这会影响所有共享运行时使用者；忙碌目标会等待空闲，不会被强制中断。\n旧镜像中的使用者需要先迁移到受管运行环境。\n本页面只创建任务，不批准更新。' + blockerText + manual)) return;
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((value) => value.toString(16).padStart(2, '0')).join('');
      pending = { id, version }; uncertain = true; submitting = true;
      if (!savePending()) {
        pending = undefined; uncertain = false; submitting = false;
        notice('未提交运行时更新：浏览器会话存储无法保存任务编号，请恢复存储后重试。'); render(); return;
      }
      render();
      const generation = authGeneration;
      try {
        const result = await api('runtime-updates', { version, idempotencyKey: id });
        if (generation !== authGeneration) return;
        if (isJob(result) && result.id === id && result.version === version) {
          uncertain = false; remember(result); notice('运行时更新任务已提交。请按任务编号监控安装与空闲等待。');
        } else {
          uncertain = true; notice('提交响应不完整，将按原任务编号查询；不会自动再次提交。');
        }
      } catch (error) {
        if (generation !== authGeneration) return;
        if (error.status === 400) { clearPending(); notice('精确稳定版本无效或请求参数被拒绝；请刷新官方发布目录后重新选择。'); }
        else if (error.status === 409) { clearPending(); notice('Gate 正在处理其他任务，或运行时更新策略已禁用。'); }
        else notice('未收到确定的提交结果，将按原任务编号查询；不会自动再次提交。');
      } finally {
        submitting = false; render();
        if (generation === authGeneration) {
          if (pending && uncertain) await lookupPending();
          else if (!pending) await poll();
        }
      }
    });
    get('runtime-update-query').addEventListener('click', async () => { await lookupPending(); });
    get('runtime-version-search').addEventListener('input', async () => { await refreshCatalog(true); });
    get('runtime-version-refresh').addEventListener('click', async () => { await refreshCatalog(true); await refreshReadiness(); });
    get('runtime-version-more').addEventListener('click', async () => { await refreshCatalog(false); });
    function updateAuth() { render(); }
    function clearProtected() {
      jobs.clear(); policy = undefined; catalogState = undefined; catalogVersions = []; nextCursor = undefined; selectedVersion = undefined; readinessState = undefined; catalogLoading = false; readinessLoading = false; catalogSequence++; readinessSequence++; get('runtime-update-version').value = ''; render();
    }
    return { updateAuth, clearProtected, poll };
  })();
`;
