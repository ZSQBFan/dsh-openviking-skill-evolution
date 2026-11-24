window.__ModuleLoader__.load({
  id: 'dsh-openviking-skill-evolution',
  factory(require) {
    const React = require('react');
    const { createElement: h, useEffect, useRef, useState } = React;
    const ns = 'dsh-openviking-skill-evolution';
    const endpoint = `api/${ns}/dashboard`;
    const proposalActions = ['preview', 'approve', 'reject', 'rollback'];
    const skillActions = ['adopt', 'archive', 'restore'];
    const countFields = ['maxTurns', 'maxToolCalls', 'maxFailures', 'cooldownMs'];
    const textFields = ['provider', 'model', 'correctionWords'];
    const modeHelp = { auto: 'autoHelp', approval: 'approvalHelp', shadow: 'shadowHelp', off: 'offHelp' };
    const dictionaries = {
      en: {
        title: 'Skill evolution', subtitle: 'OpenViking · Review and lifecycle', refresh: 'Refresh', run: 'Run review',
        loading: 'Loading dashboard…', refreshing: 'Refreshing dashboard…', working: 'Working…', overview: 'Overview', history: 'Run history',
        proposals: 'Proposals', curatorTitle: 'Curator', settingsTitle: 'Settings', usage: 'Usage', memory: 'Memory',
        noHistory: 'No review runs yet.', noProposals: 'No proposals yet.', noSkills: 'No managed skills yet.',
        empty: 'No data reported.', status: 'Status', mode: 'Review mode', lastRun: 'Last run', nextRun: 'Next run',
        idle: 'Idle', running: 'Running', disabled: 'Disabled', off: 'Off', manual: 'Manual', shadow: 'Keep drafts only',
        propose: 'Propose', approval: 'Ask before updating', auto: 'Update automatically (recommended)', pending: 'Pending',
        ready: 'Ready', applied: 'Applied', rolled_back: 'Rolled back', rejected: 'Rejected', archived: 'Archived', restored: 'Restored',
        indexUnconfirmed: 'Skill version verified. Search indexing is still unconfirmed.',
        removalIndexUnconfirmed: 'Skill removal verified. Search indexing is still unconfirmed.',
        active: 'Active', failed: 'Failed', skipped: 'Skipped', session: 'Session ID',
        currentSession: 'Use the current session', sessionPlaceholder: 'Enter a session ID',
        reviewNeedsSession: 'Open a session or enter its ID to run a review.', reviewOff: 'Enable a review mode to run a review.',
        no_session: 'Session unavailable. Open a regular conversation or check the session ID.',
        no_evidence: 'This conversation has no reviewable activity yet.', deduped: 'This conversation has already been reviewed. There is no new activity.',
        busy: 'A review is already running. Try again after it finishes.', settings: 'Save settings', preview: 'Preview',
        approve: 'Approve', reject: 'Reject', rollback: 'Rollback', curator: 'Run curator',
        adopt: 'Adopt', archive: 'Archive', restore: 'Restore', uri: 'Private skill URI',
        confirm: 'Confirm', cancel: 'Cancel', close: 'Close',
        confirmApprove: 'Apply this proposal to the skill?', confirmReject: 'Reject this proposal?',
        confirmRollback: 'Restore the version saved before this proposal was applied?',
        confirmArchive: 'Archive this skill?', confirmRestore: 'Restore this skill?',
        actionComplete: 'Operation completed.', operationFailed: 'The host could not complete this operation.',
        unavailable: 'The dashboard is unavailable on this host.', forbidden: 'This operation is unavailable.',
        badRequest: 'The host rejected the request.', mediaType: 'The host rejected the request format.',
        tooLarge: 'The request exceeds the supported size.', unauthorized: 'Open an authenticated DSH page to continue.',
        network: 'The connection to the host was interrupted.', details: 'Details', result: 'Result', before: 'Before', after: 'After', diff: 'Diff',
        inputTokens: 'Input tokens', outputTokens: 'Output tokens', cachedTokens: 'Cached tokens', totalTokens: 'Total tokens',
        runs: 'Runs', cost: 'Cost', durationMs: 'Duration (ms)', source: 'Source', reason: 'Reason',
        provider: 'Provider', model: 'Model', peer: 'Peer', available: 'Available', unavailableStatus: 'Unavailable',
        maxTurns: 'Turn limit', maxToolCalls: 'Tool-call limit', maxFailures: 'Failure limit', cooldownMs: 'Cooldown (ms)',
        correctionWords: 'Correction phrases (one per line)', curatorScope: 'Lifecycle actions apply to private skills managed by this plugin.',
        metric: 'Metric', value: 'Value', advanced: 'Advanced settings', nextScan: 'Next check', connection: 'OpenViking connection', reuse: 'Uses the account configured in OpenViking Memory.', configuredWriter: 'Uses the configured OpenViking connection.', localDrafts: 'Drafts stay on this device. Connect OpenViking Memory to apply updates.', modelDefault: 'Leave both model fields blank to use the current conversation model.', modeHelp: 'Choose what happens when DSH learns an improvement to a skill.', cooldownMinutes: 'Minimum time between reviews (minutes)',
         effectiveMode: 'Current behavior', autoHelp: 'Apply improvements to your private skills automatically.',
         approvalHelp: 'Show each improvement for your approval before updating.', shadowHelp: 'Keep suggestions on this device for you to inspect.', offHelp: 'Pause skill reviews and learning.',
      },
      zh: {
        title: '技能演进', subtitle: 'OpenViking · 复盘与生命周期', refresh: '刷新', run: '运行复盘',
        loading: '正在加载仪表板…', refreshing: '正在刷新仪表板…', working: '正在处理…', overview: '概览', history: '运行历史',
        proposals: '提案', curatorTitle: '技能治理', settingsTitle: '设置', usage: '用量', memory: '记忆',
        noHistory: '暂无复盘记录。', noProposals: '暂无提案。', noSkills: '暂无纳管技能。',
        empty: '暂无数据。', status: '状态', mode: '复盘模式', lastRun: '最近运行', nextRun: '下次运行',
        idle: '空闲', running: '运行中', disabled: '已禁用', off: '关闭', manual: '手动', shadow: '只保存草稿',
        propose: '生成提案', approval: '确认后更新', auto: '自动更新（推荐）', pending: '待处理',
        ready: '就绪', applied: '已应用', rolled_back: '已回滚', rejected: '已驳回', archived: '已归档', restored: '已恢复',
        indexUnconfirmed: '技能版本已核验，搜索索引尚未确认。',
        removalIndexUnconfirmed: '已核验技能移除，搜索索引尚未确认。',
        active: '活跃', failed: '失败', skipped: '已跳过', session: '会话 ID',
        currentSession: '使用当前会话', sessionPlaceholder: '输入会话 ID',
        reviewNeedsSession: '打开一个会话，或输入会话 ID 后再运行复盘。', reviewOff: '开启复盘模式后即可运行复盘。',
        no_session: '会话不可用。请打开普通会话或核对会话 ID。',
        no_evidence: '这个会话暂时没有可复盘的活动。', deduped: '这个会话已复盘，暂无新活动。',
        busy: '已有复盘正在运行，请在完成后重试。', settings: '保存设置', preview: '预览',
        approve: '批准', reject: '驳回', rollback: '回滚', curator: '运行治理',
        adopt: '纳管', archive: '归档', restore: '恢复', uri: '私有技能 URI',
        confirm: '确认', cancel: '取消', close: '关闭',
        confirmApprove: '将此提案应用到技能？', confirmReject: '驳回这项提案？',
        confirmRollback: '恢复此提案应用前保存的版本？', confirmArchive: '归档这项技能？', confirmRestore: '恢复这项技能？',
        actionComplete: '操作已完成。', operationFailed: '主机未完成此操作。',
        unavailable: '当前主机未提供仪表板。', forbidden: '当前操作不可用。',
        badRequest: '主机未接受此请求。', mediaType: '主机未接受此请求格式。',
        tooLarge: '请求超出大小限制。', unauthorized: '请打开已认证的 DSH 页面后继续。',
        network: '与主机的连接中断。', details: '详情', result: '结果', before: '修改前', after: '修改后', diff: '差异',
        inputTokens: '输入 token', outputTokens: '输出 token', cachedTokens: '缓存 token', totalTokens: '总 token',
        runs: '运行次数', cost: '费用', durationMs: '耗时（毫秒）', source: '来源', reason: '原因',
        provider: '提供商', model: '模型', peer: '项目记忆空间', available: '可用', unavailableStatus: '不可用',
        maxTurns: '轮次上限', maxToolCalls: '工具调用上限', maxFailures: '失败次数上限', cooldownMs: '冷却时间（毫秒）',
        correctionWords: '纠正短语（每行一个）', curatorScope: '生命周期操作仅适用于此插件纳管的私有技能。',
        metric: '指标', value: '数值', advanced: '高级设置', nextScan: '下次检查', connection: 'OpenViking 连接', reuse: '沿用 OpenViking 记忆插件中已配置的账号。', configuredWriter: '使用已配置的 OpenViking 连接。', localDrafts: '改进会保存在本机。连接 OpenViking 记忆插件后，可将改进写回技能库。', modelDefault: '提供商和模型留空时，沿用当前会话的模型。', modeHelp: '选择 DSH 学到值得保留的经验后，如何更新技能。', cooldownMinutes: '自动复盘最短间隔（分钟）',
         effectiveMode: '当前实际行为', autoHelp: '符合条件的改进会自动写入你的私有技能，并保留可恢复的版本。',
         approvalHelp: '先向你展示改进，确认后才更新技能。', shadowHelp: '把改进保存在本机，供你查看。', offHelp: '暂停技能复盘和学习。',
      },
    };
    const known = (t, key) => Object.hasOwn(dictionaries.en, key) ? t(key) : key;
    const rows = value => Array.isArray(value) ? value : [];
    const confirmCopy = {
      approve: 'confirmApprove', reject: 'confirmReject', rollback: 'confirmRollback',
      archive: 'confirmArchive', restore: 'confirmRestore',
    };

    async function requestDashboard(signal, operation) {
      const send = window.__DSH_TRANSPORT__?.fetch ?? window.fetch.bind(window);
      const response = await send(endpoint, {
        signal, credentials: 'same-origin', cache: 'no-store',
        ...(operation ? {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operation),
        } : { method: 'GET' }),
      });
      const transportErrors = { 401: 'unauthorized', 403: 'forbidden', 404: 'unavailable' };
      if (transportErrors[response.status]) throw new Error(transportErrors[response.status]);
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.error || 'operationFailed');
      return result.data;
    }

    function activateOnEnter(event) {
      if (event.key !== 'Enter' || event.defaultPrevented || event.nativeEvent.isComposing ||
          event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      if (!event.repeat) event.currentTarget.click();
    }

    function Button({ children, primary, ...props }) {
      return h('button', { type: 'button', className: primary ? 'ove-button ove-primary' : 'ove-button', ...props }, children);
    }

    function Card({ title, children }) {
      return h('section', { className: 'ove-card' }, h('h2', null, title), children);
    }

    function Value({ value, t }) {
      if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
        return h('pre', { className: 'ove-code' }, JSON.stringify(value, null, 2));
      }
      if (value === null || value === undefined || value === '') return '—';
      if (typeof value === 'boolean') return t(value ? 'available' : 'unavailableStatus');
      if (typeof value === 'number') return value.toLocaleString();
      return known(t, String(value));
    }

    function Facts({ data, t }) {
      const entries = Object.entries(data ?? {}).filter(([, value]) => value !== null && value !== undefined);
      if (!entries.length) return h('p', { className: 'ove-muted' }, t('empty'));
      return h('dl', { className: 'ove-facts' }, entries.map(([key, value]) => h(React.Fragment, { key },
        h('dt', null, known(t, key)), h('dd', null, h(Value, { value, t })))));
    }

    function Usage({ data, t }) {
      const entries = Object.entries(data ?? {}).filter(([, value]) => value !== null && value !== undefined);
      if (!entries.length) return h('p', { className: 'ove-muted' }, t('empty'));
      return h('table', { className: 'ove-usage' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, t('metric')), h('th', { scope: 'col' }, t('value')))),
        h('tbody', null, entries.map(([key, value]) => h('tr', { key },
          h('th', { scope: 'row' }, known(t, key)), h('td', null, h(Value, { value, t }))))));
    }

    function Diff({ preview, t }) {
      const operations = Array.isArray(preview?.operations) ? preview.operations : [];
      if (!operations.length) return h(BodyDiff, { preview, t });
      return h('div', null, preview.diff && h(BodyDiff, { preview, t }),
        operations.map(item => h('details', { key: item.path },
          h('summary', null, `${item.action === 'remove_file' ? '−' : item.baseSha256 === null ? '+' : '~'} ${item.path}`),
          h('pre', { className: 'ove-code' }, item.content ?? item.baseSha256))));
    }

    function BodyDiff({ preview, t }) {
      if (typeof preview === 'string' || typeof preview?.diff === 'string') {
        const text = typeof preview === 'string' ? preview : preview.diff;
        return h('pre', { className: 'ove-code', 'aria-label': t('diff') }, text.split('\n').map((line, i) => h('span', {
          key: i, className: line.startsWith('+') ? 'ove-add' : line.startsWith('-') ? 'ove-delete' : undefined,
        }, line, '\n')));
      }
      if (typeof preview?.before === 'string' || typeof preview?.after === 'string') {
        return h('div', { className: 'ove-pair' }, ['before', 'after'].map(key => h('div', { key },
          h('h3', null, t(key)), h('pre', { className: 'ove-code' }, preview[key] ?? '—'))));
      }
      return h(Value, { value: preview, t });
    }

    const noCurrentSession = () => undefined;
    const selectCurrentSession = state => Object.values(state.byId)
      .find(session => !session.blank && (session.retainedBy.mainView ?? 0) > 0)?.id;

    function Dashboard({ t, useSessions = noCurrentSession }) {
      const currentSessionId = useSessions(selectCurrentSession);
      const [data, setData] = useState(null);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState('');
      const [refreshing, setRefreshing] = useState(false);
      const [session, setSession] = useState('');
      const [uri, setUri] = useState('');
      const [draft, setDraft] = useState(null);
      const [preview, setPreview] = useState(null);
      const [confirmation, setConfirmation] = useState(null);
      const connection = useRef(null);
      const pending = useRef(false);
      const reading = useRef(null);

      async function refresh(signal = connection.current?.signal, fresh = false, manual = false) {
        if (!signal || signal.aborted || (!fresh && reading.current?.signal === signal)) return;
        const read = { signal, manual: manual || (reading.current?.signal === signal && reading.current.manual) };
        reading.current = read;
        if (manual) setRefreshing(true);
        try {
          const next = await requestDashboard(signal);
          if (!signal.aborted && reading.current === read) {
            setData(next);
            setError('');
          }
        } catch (cause) {
          if (!signal.aborted && reading.current === read) {
            setError(Object.hasOwn(dictionaries.en, cause.message) ? cause.message : 'network');
          }
        } finally {
          if (reading.current === read) {
            reading.current = null;
            if (!signal.aborted && read.manual) setRefreshing(false);
          }
        }
      }

      async function refreshFromButton() {
        const signal = connection.current?.signal;
        if (!signal || signal.aborted || pending.current || reading.current?.manual) return;
        await refresh(signal, true, true);
      }

      useEffect(() => {
        const controller = new AbortController();
        connection.current = controller;
        void refresh(controller.signal);
        const timer = setInterval(() => {
          if (!pending.current && document.visibilityState !== 'hidden') void refresh(controller.signal);
        }, 15_000);
        return () => { clearInterval(timer); controller.abort(); };
      }, []);

      async function run(action, input) {
        const signal = connection.current?.signal;
        if (!signal || signal.aborted || pending.current) return;
        pending.current = true;
        setBusy(action);
        setConfirmation(null);
        setNotice(null);
        try {
          const reply = await requestDashboard(signal, { action, input });
          if (signal.aborted) return;
          if (action === 'preview') setPreview({ id: input.id, value: reply });
          else {
            if (action === 'settings') setDraft(null);
            setNotice({ result: reply, action });
            await refresh(signal, true);
          }
        } catch (cause) {
          if (!signal.aborted) setNotice({ error: Object.hasOwn(dictionaries.en, cause.message) ? cause.message : 'network' });
        } finally {
          pending.current = false;
          if (!signal.aborted) setBusy('');
        }
      }

      const enabled = action => !error && data?.capabilities?.[action] === true;
      function actionButton(action, input) {
        return h(Button, { key: action, disabled: !!busy || !enabled(action),
          onKeyDown: action === 'preview' ? activateOnEnter : undefined, onClick: () => {
          if (confirmCopy[action]) setConfirmation({ action, input });
          else void run(action, input);
        } }, t(action));
      }

      const settings = data?.settings ?? {};
      const modes = rows(settings.modes).map(mode => typeof mode === 'string' ? { id: mode } : mode).filter(mode => mode?.id);
      const mode = draft?.mode ?? settings.mode ?? modes[0]?.id ?? '';
      const settingsDisabled = !!busy || !enabled('settings');
      const changeSetting = (key, value) => setDraft(previous => ({ revision: settings.revision, ...previous, [key]: value }));
      function saveSettings(event) {
        event.preventDefault();
        if (!draft || settingsDisabled) return;
        const input = { ...draft };
        for (const key of countFields) {
          if (Object.hasOwn(input, key)) {
            const value = key === 'cooldownMs' ? Math.round(Number(input[key]) * 60_000) : Number(input[key]);
            if (String(input[key]).trim() === '' || !Number.isSafeInteger(value) || value < 0) {
              setNotice({ error: 'badRequest' });
              return;
            }
            input[key] = value;
          }
        }
        if (typeof input.correctionWords === 'string') input.correctionWords = input.correctionWords.split('\n').map(word => word.trim()).filter(Boolean);
        for (const key of ['provider', 'model']) if (typeof input[key] === 'string') input[key] = input[key].trim();
        void run('settings', input);
      }
      const curator = data?.curator ?? {};
      const status = typeof data?.status === 'string' ? { state: data.status } : (data?.status ?? {});
      const reviewSessionId = session.trim() || currentSessionId;
      const reviewRunning = status.state === 'running';
      const canReview = enabled('run');
      const reviewHint = settings.mode === 'off' ? 'reviewOff'
        : reviewRunning ? 'busy'
        : canReview && !reviewSessionId ? 'reviewNeedsSession' : null;
      const skillRows = rows(curator.skills);
      const proposals = rows(data?.proposals);
      const history = rows(data?.history);
      function indexWarning(item) {
        if (item.status !== 'applied' && item.status !== 'rolled_back') return null;
        const events = rows(item.history);
        const latest = events.findLastIndex(event => event.status === item.status);
        if (events[latest - 1]?.status !== 'index_unconfirmed') return null;
        return h('p', { className: 'ove-muted' }, t(item.status === 'applied' ? 'indexUnconfirmed' : 'removalIndexUnconfirmed'));
      }

      return h('div', { className: 'ove-dashboard' },
        h('style', null, css),
        h('header', { className: 'ove-header' },
          h('div', null, h('h1', null, t('title')), h('p', { className: 'ove-muted' }, t('subtitle'))),
          h('div', { className: 'ove-controls' },
            h(Button, { disabled: !!busy || refreshing, onClick: refreshFromButton }, t('refresh')),
            refreshing && h('span', { role: 'status', className: 'ove-muted' }, t('refreshing')))),
        error && h('p', { role: 'alert', className: 'ove-message' }, t(error)),
        !data && !error && h('p', { role: 'status' }, t('loading')),
        busy && h('p', { role: 'status', className: 'ove-message' }, t('working')),
        notice?.error && h('p', { role: 'alert', className: 'ove-message' }, t(notice.error)),
        notice && !notice.error && h('div', { className: 'ove-message', role: 'status' },
          h('strong', null, t('result')),
          notice.action === 'run' && ['no_session', 'no_evidence', 'deduped', 'busy'].includes(notice.result?.status)
            ? ` · ${t(notice.result.status)}`
            : notice.result === null ? ` · ${t('actionComplete')}` : h(Value, { value: notice.result, t })),
        confirmation && h('section', { className: 'ove-message ove-controls', role: 'group', 'aria-label': t(confirmCopy[confirmation.action]) },
          h('span', null, t(confirmCopy[confirmation.action]), ' ', confirmation.input.id ?? confirmation.input.uri),
          h(Button, { onClick: () => setConfirmation(null) }, t('cancel')),
          h(Button, { primary: true, disabled: !!busy || !enabled(confirmation.action), onClick: () => void run(confirmation.action, confirmation.input) }, t('confirm'))),
        data && h(React.Fragment, null,
          h(Card, { title: t('settingsTitle') },
            settings.writeConnection && h('p', null, h('strong', null, t('connection')), ' · ',
              t(settings.writeConnection === 'unavailable' ? 'localDrafts' : settings.writeConnection === 'native-verified-readback' ? 'reuse' : 'configuredWriter')),
            settings.effectiveMode && settings.effectiveMode !== settings.mode && h('p', { className: 'ove-muted' },
              t('effectiveMode'), ' · ', known(t, settings.effectiveMode)),
            h('p', { className: 'ove-muted' }, t(modeHelp[mode] ?? 'modeHelp')),
            h('form', { className: 'ove-settings', onSubmit: saveSettings },
            modes.length > 0 && h('label', null, t('mode'), h('select', {
              value: mode, disabled: settingsDisabled, onChange: event => changeSetting('mode', event.target.value),
            }, modes.map(option => h('option', { key: option.id, value: option.id }, known(t, option.id))))),
            h('details', { className: 'ove-advanced' }, h('summary', { onKeyDown: activateOnEnter }, t('advanced')),
              h('p', { className: 'ove-muted' }, t('modelDefault')),
              h('div', { className: 'ove-settings ove-settings-grid' }, [...countFields, ...textFields].map(key => {
              const isCount = countFields.includes(key);
              const isPhrases = key === 'correctionWords';
              const minutes = key === 'cooldownMs';
              const current = settings[key];
              const value = draft?.[key] ?? (minutes && Number.isFinite(current) ? current / 60_000 : current) ?? '';
              return h('label', { key }, t(minutes ? 'cooldownMinutes' : key), h(isPhrases ? 'textarea' : 'input', {
                ...(isPhrases ? { rows: 3 } : { type: isCount ? 'number' : 'text' }),
                ...(isCount ? { min: minutes ? 0 : 1, step: minutes ? 'any' : 1 } : {}),
                value: Array.isArray(value) ? value.join('\n') : value,
                disabled: settingsDisabled, onChange: event => changeSetting(key, event.target.value),
              }));
            }))),
            h('div', { className: 'ove-controls' }, h(Button, { type: 'submit', disabled: settingsDisabled || !draft }, t('settings'))))),
          h(Card, { title: t('overview') },
            h('div', { className: 'ove-controls' },
              h('span', { className: 'ove-status' }, h(Value, { value: status.state ?? status.status, t })),
              h('label', null, t('session'), ' ', h('input', {
                value: session, placeholder: t(currentSessionId ? 'currentSession' : 'sessionPlaceholder'), disabled: !canReview || !!busy,
                onChange: event => setSession(event.target.value),
              })),
              h(Button, { primary: true, disabled: !!busy || !canReview || !reviewSessionId || reviewRunning,
                onClick: () => void run('run', { sessionId: reviewSessionId }) }, t('run'))),
            reviewHint && h('p', { className: 'ove-muted' }, t(reviewHint)),
            h(Facts, { t, data: Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'state' && key !== 'status')) })),
          h(Card, { title: t('proposals') }, proposals.length ? h('ul', { className: 'ove-list' }, proposals.map(item => h('li', { key: item.id },
            h('div', { className: 'ove-row' }, h('div', null,
              h('strong', null, item.title ?? item.uri ?? item.id), ' ', h('span', { className: 'ove-status' }, h(Value, { value: item.status, t })),
              item.summary && h('p', { className: 'ove-muted' }, item.summary), indexWarning(item)),
            h('div', { className: 'ove-controls' }, proposalActions.filter(action => enabled(action) && (!Array.isArray(item.actions) || item.actions.includes(action))).map(action => actionButton(action, { id: item.id })))),
            preview?.id === item.id && h('div', { className: 'ove-preview' },
              h('div', { className: 'ove-row' }, h('h3', null, t('preview')), h(Button, { onClick: () => setPreview(null) }, t('close'))),
              h(Diff, { preview: preview.value, t })),
          ))) : h('p', { className: 'ove-muted' }, t('noProposals'))),
          h(Card, { title: t('history') }, history.length ? h('ul', { className: 'ove-list' }, history.map((item, i) => h('li', { key: item.id ?? i },
            h('details', null, h('summary', null, item.at ?? item.startedAt ?? item.id ?? '', ' ', h(Value, { value: item.status ?? item.state, t })), h(Facts, { data: item, t })),
          ))) : h('p', { className: 'ove-muted' }, t('noHistory'))),
          h(Card, { title: t('curatorTitle') },
            h('p', { className: 'ove-muted' }, t('curatorScope')),
            h('div', { className: 'ove-controls' }, enabled('curator') && actionButton('curator', {}), enabled('adopt') && h('form', {
              className: 'ove-controls', onSubmit: event => { event.preventDefault(); if (uri.trim()) void run('adopt', { uri: uri.trim() }); },
            }, h('label', null, t('uri'), ' ', h('input', { value: uri, onChange: event => setUri(event.target.value), disabled: !!busy })),
            h(Button, { type: 'submit', disabled: !!busy || !uri.trim() }, t('adopt')))),
            Number.isFinite(curator.nextScan) && h('p', { className: 'ove-muted' }, `${t('nextScan')} · ${new Date(curator.nextScan).toLocaleString()}`),
            rows(curator.audit).length > 0 && h('details', null, h('summary', null, t('history')), h(Value, { value: curator.audit, t })),
            skillRows.length ? h('ul', { className: 'ove-list' }, skillRows.map(item => h('li', { className: 'ove-row', key: item.uri },
              h('div', null, h('strong', null, item.title ?? item.uri), ' ', h('span', { className: 'ove-status' }, h(Value, { value: item.status, t }))),
              h('div', { className: 'ove-controls' }, skillActions.filter(action => enabled(action) && (item.actions?.includes(action) ??
                (action === (item.status === 'archived' ? 'restore' : 'archive')))).map(action => actionButton(action, { uri: item.uri }))),
            ))) : h('p', { className: 'ove-muted' }, t('noSkills'))),
          h('div', { className: 'ove-pair' },
            h(Card, { title: t('usage') }, h(Usage, { data: data.usage, t })),
            h(Card, { title: t('memory') }, h(Facts, { data: data.memory, t }))),
        ),
      );
    }

    const css = `
      .ove-dashboard { display:grid; gap:12px; width:100%; min-width:0; color:var(--dsw-alias-text-primary, inherit); }
      .ove-dashboard :is(h1,h2,h3,p,dl) { margin:0; }
      .ove-dashboard h1 { font-size:21px; margin-bottom:3px; }
      .ove-dashboard h2 { font-size:15px; }
      .ove-dashboard h3 { font-size:13px; }
      .ove-header,.ove-row { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .ove-controls { display:flex; align-items:center; flex-wrap:wrap; gap:7px; }
      .ove-card,.ove-message { min-width:0; display:grid; gap:10px; border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4)); padding:14px; border-radius:12px; background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2)); }
      .ove-message.ove-controls { display:flex; }
      .ove-card label { display:inline-flex; align-items:center; flex-wrap:wrap; gap:7px; }
      .ove-muted,.ove-facts dt { color:var(--dsw-alias-text-secondary,currentColor); }
      .ove-status { display:inline-block; font-size:12px; border-radius:999px; padding:2px 7px; background:var(--dsw-alias-bg-layer-3); }
      .ove-dashboard :is(button,input,select,textarea) { border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4)); border-radius:7px; color:inherit; background:var(--dsw-alias-bg-layer-3); padding:5px 8px; font:inherit; }
      .ove-settings { display:grid; gap:10px; }
      .ove-settings-grid { margin-top:10px; grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr)); }
      .ove-settings label { display:grid; grid-template-rows:auto 1fr; align-content:start; min-width:0; }
      .ove-advanced:not([open]) > :not(summary) { display:none; }
      .ove-advanced > p { margin-top:8px; }
      .ove-settings textarea { resize:vertical; }
      .ove-settings > .ove-controls { grid-column:1 / -1; }
      .ove-usage { width:100%; border-collapse:collapse; text-align:left; }
      .ove-usage :is(th,td) { border-bottom:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4)); padding:5px 0; vertical-align:top; }
      .ove-dashboard input { max-width:100%; }
      .ove-dashboard button:enabled,.ove-dashboard summary { cursor:pointer; }
      .ove-dashboard button:disabled { opacity:.48; }
      .ove-dashboard button.ove-primary { font-weight:650; border-color:currentColor; }
      .ove-dashboard :is(button,input,select,summary):focus-visible { outline:2px solid var(--dsw-alias-text-primary,currentColor); outline-offset:2px; }
      .ove-list { display:grid; gap:8px; padding:0; margin:0; list-style:none; }
      .ove-list > li { border-top:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4)); padding-top:8px; overflow-wrap:anywhere; }
      .ove-row > div { min-width:0; }
      .ove-facts { display:grid; grid-template-columns:minmax(72px,max-content) minmax(0,1fr); gap:5px 12px; }
      .ove-facts dd { margin:0; min-width:0; overflow-wrap:anywhere; }
      .ove-preview { margin-top:9px; }
      .ove-code { box-sizing:border-box; margin:5px 0 0; max-width:100%; max-height:320px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; padding:9px; border-radius:6px; background:var(--dsw-alias-bg-layer-3); }
      .ove-add { color:var(--dsw-alias-text-success,currentColor); }
      .ove-delete { color:var(--dsw-alias-text-error,currentColor); }
      .ove-pair { display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); }
      .ove-pair > div { min-width:0; }
    `;

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(ns, dictionaries), `${ns}: dashboard locales`);
        const t = ctx.locale.bind(ns);
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: ns, order: 60, label: () => t('title'), locale: ns,
        }, Dashboard));
      },
    };
  },
});
