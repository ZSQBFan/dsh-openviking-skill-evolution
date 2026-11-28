window.__ModuleLoader__.load({
  id: 'dsh-openviking-skill-evolution',
  factory(require) {
    const React = require('react');
    const { createElement: h, useEffect, useRef, useState } = React;
    const ns = 'dsh-openviking-skill-evolution';
    const endpoint = `api/${ns}/dashboard`;
    const proposalActions = ['preview', 'verifyWrite', 'approve', 'reject', 'rollback'];
    const approvalStates = new Set(['pending', 'applying', 'applied', 'write_unconfirmed', 'index_unconfirmed', 'rejected', 'rolled_back', 'restoring']);
    const unconfirmedStates = new Set(['write_unconfirmed', 'index_unconfirmed']);
    const proposalStatus = item => ['applying', 'restoring'].includes(item.status) && unconfirmedStates.has(rows(item.history).at(-1)?.status)
      ? item.history.at(-1).status : item.status;
    const canVerifyWrite = item => Array.isArray(item?.actions) && item.actions.includes('verifyWrite');
    const autoVerificationActive = item => canVerifyWrite(item) && Number.isFinite(item?.verification?.nextAt);
    const displayedProposalStatus = item => autoVerificationActive(item) ? 'autoVerifying' : proposalStatus(item);
    const draftReasons = new Set([
      'draft_mode', 'draft_connection_unavailable', 'draft_identity_unverified',
      'draft_target_not_owned', 'draft_target_unmanaged', 'draft_legacy',
    ]);
    const draftApplyNotices = new Map(Object.entries({
      applied: 'applied', pending: 'pending', applying: 'applying', restoring: 'restoring', rolled_back: 'rolled_back', rejected: 'rejected',
      conflict: 'draftApplyConflict', disabled: 'draft_reviews_disabled', archived: 'draftApplyArchived', proposal_cleared: 'proposal_cleared',
      draft_connection_unavailable: 'draft_connection_unavailable', draft_identity_unverified: 'draft_identity_unverified',
      draft_target_not_owned: 'draft_target_not_owned', draft_target_unmanaged: 'draft_target_unmanaged', not_managed: 'draft_target_unmanaged',
      missing: 'draftApplyMissing', cancelled: 'draftApplyCancelled', unresolved_write: 'draftApplyUnresolved',
      write_unconfirmed: 'draftApplyWriteUnconfirmed', index_unconfirmed: 'indexUnconfirmed',
    }));
    const skillActions = ['archive', 'restore'];
    const skillTransitions = {
      archive: { status: 'archived', nextAction: 'restore', progress: 'skillArchiving', success: 'skillArchived' },
      restore: { status: 'active', nextAction: 'archive', progress: 'skillRestoring', success: 'skillRestored' },
    };
    const numericFields = {
      maxTurns: { scale: 1, min: 1, max: 1000 },
      maxToolCalls: { scale: 1, min: 1, max: 1000 },
      maxFailures: { scale: 1, min: 1, max: 1000 },
      maxDurationMs: { label: 'durationMinutes', scale: 60_000, min: 1, max: 604_800_000 },
      reviewTimeoutMs: { label: 'reviewTimeoutSeconds', scale: 1000, min: 1, max: 604_800_000 },
      cooldownMs: { label: 'cooldownMinutes', scale: 60_000, min: 0, max: 604_800_000 },
    };
    const settingsLabels = { provider: 'reviewProvider', model: 'reviewModel' };
    const textFields = ['provider', 'model', 'correctionWords'];
    const dateFields = new Set(['at', 'createdAt', 'finishedAt', 'startedAt', 'updatedAt', 'lastRun', 'nextRun', 'nextScan', 'lastUsed', 'retryAt']);
    const modeHelp = { auto: 'autoHelp', approval: 'approvalHelp', shadow: 'shadowHelp', off: 'offHelp' };
    const dictionaries = {
      en: {
        durationMinutes: 'Review trigger duration (minutes)', reviewTimeoutSeconds: 'Model review timeout (seconds)',
        reviewProvider: 'Review provider ID', reviewModel: 'Review model ID', usingSessionModel: 'Reviews use the source session’s model when either ID is blank.',
        older: 'Older entries', processedProposals: 'Processed proposals', verifyWrite: 'Verify write',
        needsVerification: 'Awaiting verification', verifying_write: 'Verifying write', autoVerifying: 'Automatically verifying',
        approveAll: 'Approve all proposals', verifyAll: 'Verify writes', batchProcessed: 'Processed {done} / {total}',
        batchApplied: '{count} applied', batchVerified: '{count} verified', batchVerify: '{count} awaiting verification', batchOther: '{count} not confirmed as applied',
        batchDetails: 'Results by proposal',
        write_unconfirmed: 'Write unconfirmed', index_unconfirmed: 'Index unconfirmed', createdAt: 'Created', startedAt: 'Started', finishedAt: 'Finished', retryAt: 'Retry after', stage: 'Stage', errorCode: 'Error code',
        timed_out: 'Review timed out', review_source_busy: 'The source session is still running.',
        cooldown: 'The review is in cooldown.', retry_blocked: 'Retry blocked by the review retry policy.',
        review_model_unavailable: 'The review model is unavailable.',
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
        adopt: 'Adopt', archive: 'Archive', restore: 'Restore', uri: 'Private skill URI', managedSkills: 'Managed skills',
        skillArchiving: 'Archiving…', skillRestoring: 'Restoring…', skillArchived: 'Skill archived.', skillRestored: 'Skill restored.',
        skillOutOfScope: 'This skill is no longer managed by the current profile.',
        confirm: 'Confirm', cancel: 'Cancel', close: 'Close',
        confirmApprove: 'Apply this proposal to the skill?', confirmVerifyWrite: 'Verify the result of the previous write?', confirmReject: 'Reject this proposal?',
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
        maxTurns: 'Trigger after this many conversation turns', maxToolCalls: 'Trigger after this many tool calls',
        maxFailures: 'Trigger after this many conversation errors', cooldownMs: 'Cooldown (ms)',
        triggerHelp: 'These counts are for the source conversation since its last review. Reaching any threshold makes an automatic review eligible at the end of a turn.',
        skillUsage: 'Skill usage', noSkillUsage: 'No skill loads recorded yet.', skillName: 'Skill', skillLoads: 'Loads', lastUsed: 'Last used',
        memoryLink: 'OpenViking link', memoryRecall: 'Recall into this conversation', memoryCapture: 'Save conversation to memory',
        memoryTools: 'Save tool results', memoryWriteState: 'Memory writes', memoryQueued: 'Waiting to sync', memoryNoneQueued: 'No writes pending',
        memoryScope: 'Recall scope', memoryActor: 'Current agent', memoryAll: 'All accessible agents',
        memoryOn: 'On', memoryOff: 'Off', memoryUnknown: 'Unknown', memoryLinked: 'Linked', memoryUnobserved: 'Session state not available yet',
        memorySession: 'Current conversation', memoryNoSession: 'No conversation selected',
        memoryConfigured: 'Configured', memoryObserved: 'Connection observed',
        memoryInitializing: 'Connecting', memoryExcluded: 'Excluded from memory', memoryUnavailable: 'Memory plugin unavailable',
        memoryExperiences: 'Experience activity', memoryInjected: 'Read into context', memoryRecalled: 'Found in recall',
        technicalDetails: 'Technical details', dshSessionId: 'DSH session ID', ovSessionId: 'OpenViking session ID', peerId: 'Memory space',
        lastInjectedSeq: 'Last recall event', lastProfileSeq: 'Last profile event', lastCommitBoundarySeq: 'Last save boundary',
        remoteCommit: 'Remote save status', unverified: 'Unverified',
        clearProposals: 'Clear proposals', clearHistory: 'Clear run history',
        confirmClearProposals: 'Clear the proposal list? Applied skill versions remain available for rollback.',
        confirmClearHistory: 'Clear the displayed run history?',
        proposals_cleared: 'Proposals cleared.', history_cleared: 'Run history cleared.', invalid_confirm: 'Confirm this action to clear the records.',
        proposal_cleared: 'This proposal was cleared.',
        localDraft: 'Local draft', applyDraft: 'Approve and apply', draftReason: 'Why this is a draft',
        draftReasonStillBlocked: 'Why this is still a draft', applyBlockedReason: 'Why it is blocked now',
        draft_mode: 'The review mode is set to keep drafts only.',
        draft_connection_unavailable: 'A writable OpenViking connection is unavailable.',
        draft_identity_unverified: 'The OpenViking account could not be verified.',
        draft_target_not_owned: 'The target skill does not belong to the current OpenViking account.',
        draft_target_unmanaged: 'The target skill is not managed by this plugin.',
        draft_legacy: 'The draft was saved without a recorded reason.',
        draft_reviews_disabled: 'Reviews are turned off.',
        draftApplyArchived: 'The target skill is archived.', draftApplyUnavailable: 'This draft could not be applied.',
        conflict: 'Version conflict', applying: 'Applying', restoring: 'Restoring',
        draftApplyConflict: 'The target skill has changed. The draft was not applied.',
        draftApplyMissing: 'This draft is no longer available.', draftApplyCancelled: 'Draft application was cancelled.',
        draftApplyUnresolved: 'An earlier write to this skill still needs verification.',
        draftApplyWriteUnconfirmed: 'The write could not be verified. Check the proposal status before trying again.',
        preservedVersions: 'Saved versions and recovery', no_change: 'No changes needed',
        correctionWords: 'Correction phrases (one per line)', curatorScope: 'Lifecycle actions apply to private skills managed by this plugin.',
        metric: 'Metric', value: 'Value', advanced: 'Advanced settings', nextScan: 'Next check', connection: 'OpenViking connection', reuse: 'Uses the user identity verified by OpenViking for the current connection.', configuredWriter: 'Uses the configured OpenViking connection.', localDrafts: 'Drafts stay on this device. Connect OpenViking Memory to apply updates.', modelSelection: 'To override the source session’s model, enter both IDs from DSH’s model settings.', modeHelp: 'Choose what happens when DSH learns an improvement to a skill.', cooldownMinutes: 'Minimum time between reviews (minutes)',
         effectiveMode: 'Current behavior', autoHelp: 'Apply improvements to your private skills automatically.',
         approvalHelp: 'Show each improvement for your approval before updating.', shadowHelp: 'Keep suggestions on this device for you to inspect.', offHelp: 'Pause skill reviews and learning.',
      },
      zh: {
        durationMinutes: '复盘触发时长（分钟）', reviewTimeoutSeconds: '模型复盘超时（秒）',
        reviewProvider: '复盘提供商 ID', reviewModel: '复盘模型 ID', usingSessionModel: '未完整设置复盘模型，当前使用来源会话的模型。',
        older: '较早的记录', processedProposals: '已处理的提案', verifyWrite: '核验写入',
        needsVerification: '待核验', verifying_write: '核验中', autoVerifying: '正在自动核验',
        approveAll: '一键批准所有提案', verifyAll: '一键核验写入', batchProcessed: '已处理 {done} / {total} 项',
        batchApplied: '已应用 {count} 项', batchVerified: '已核验 {count} 项', batchVerify: '待核验 {count} 项', batchOther: '未确认应用 {count} 项',
        batchDetails: '查看每项结果',
        write_unconfirmed: '写入待核验', index_unconfirmed: '索引待核验', createdAt: '创建时间', startedAt: '开始时间', finishedAt: '完成时间', retryAt: '最早重试时间', stage: '阶段', errorCode: '错误代码',
        timed_out: '复盘超时', review_source_busy: '来源会话仍在运行。',
        cooldown: '复盘仍在冷却期。', retry_blocked: '当前复盘记录受重试策略限制。',
        review_model_unavailable: '复盘模型不可用。',
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
        adopt: '纳管', archive: '归档', restore: '恢复', uri: '私有技能 URI', managedSkills: '已纳管技能',
        skillArchiving: '正在归档…', skillRestoring: '正在恢复…', skillArchived: '技能已归档。', skillRestored: '技能已恢复。',
        skillOutOfScope: '此技能已不在当前纳管范围内。',
        confirm: '确认', cancel: '取消', close: '关闭',
        confirmApprove: '将此提案应用到技能？', confirmVerifyWrite: '核验上一次写入的结果？', confirmReject: '驳回这项提案？',
        confirmRollback: '恢复此提案应用前保存的版本？', confirmArchive: '归档这项技能？', confirmRestore: '恢复这项技能？',
        actionComplete: '操作已完成。', operationFailed: '主机未完成此操作。',
        unavailable: '当前主机未提供仪表板。', forbidden: '当前操作不可用。',
        badRequest: '主机未接受此请求。', mediaType: '主机未接受此请求格式。',
        tooLarge: '请求超出大小限制。', unauthorized: '请打开已认证的 DSH 页面后继续。',
        network: '与主机的连接中断。', details: '详情', result: '结果', before: '修改前', after: '修改后', diff: '差异',
        inputTokens: '输入 token', outputTokens: '输出 token', cachedTokens: '缓存 token', totalTokens: '总 token',
        runs: '运行次数', cost: '费用', durationMs: '耗时（毫秒）', source: '来源', reason: '原因',
        provider: '提供商', model: '模型', peer: '项目记忆空间', available: '可用', unavailableStatus: '不可用',
        maxTurns: '会话达到多少轮后触发复盘', maxToolCalls: '会话调用工具多少次后触发复盘',
        maxFailures: '会话出现多少次错误后触发复盘', cooldownMs: '冷却时间（毫秒）',
        triggerHelp: '统计上次复盘后来源会话的活动。任一项达到设定值，本轮结束后即可安排自动复盘。',
        skillUsage: '技能使用情况', noSkillUsage: '还没有技能加载记录。', skillName: '技能', skillLoads: '加载次数', lastUsed: '最近使用',
        memoryLink: 'OpenViking 连接', memoryRecall: '为此会话检索记忆', memoryCapture: '将会话写入记忆',
        memoryTools: '记录工具结果', memoryWriteState: '写入队列', memoryQueued: '等待同步', memoryNoneQueued: '没有待写入项目',
        memoryScope: '检索范围', memoryActor: '当前代理', memoryAll: '所有可访问的代理',
        memoryOn: '已开启', memoryOff: '已关闭', memoryUnknown: '未知', memoryLinked: '已关联', memoryUnobserved: '暂未读取到会话状态',
        memorySession: '当前会话', memoryNoSession: '未选中会话',
        memoryConfigured: '已配置', memoryObserved: '已检测到连接',
        memoryInitializing: '正在连接', memoryExcluded: '此会话已排除', memoryUnavailable: '记忆插件未连接',
        memoryExperiences: '经验记忆活动', memoryInjected: '已读取到上下文', memoryRecalled: '已检索',
        technicalDetails: '技术详情', dshSessionId: 'DSH 会话 ID', ovSessionId: 'OpenViking 会话 ID', peerId: '记忆空间',
        lastInjectedSeq: '最近检索事件', lastProfileSeq: '最近用户资料事件', lastCommitBoundarySeq: '最近本地提交边界',
        remoteCommit: '远端写入状态', unverified: '未核验',
        clearProposals: '清空提案', clearHistory: '清空运行历史',
        confirmClearProposals: '清空提案列表？已应用的技能版本仍可回滚。',
        confirmClearHistory: '清空显示的运行历史？',
        proposals_cleared: '已清空提案。', history_cleared: '已清空运行历史。', invalid_confirm: '请先确认清空操作。',
        proposal_cleared: '此提案已清空。',
        localDraft: '本地草稿', applyDraft: '批准并应用', draftReason: '保存为草稿的原因',
        draftReasonStillBlocked: '仍保留为草稿的原因', applyBlockedReason: '当前应用受限的原因',
        draft_mode: '当前模式设为只保存草稿。',
        draft_connection_unavailable: '当前没有可写入的 OpenViking 连接。',
        draft_identity_unverified: '当前 OpenViking 账号尚未核验。',
        draft_target_not_owned: '目标技能不属于当前 OpenViking 账号。',
        draft_target_unmanaged: '目标技能尚未由此插件纳管。',
        draft_legacy: '保存此草稿时未记录原因。',
        draft_reviews_disabled: '复盘已关闭。',
        draftApplyArchived: '目标技能已归档。', draftApplyUnavailable: '此草稿应用失败。',
        conflict: '版本冲突', applying: '应用中', restoring: '恢复中',
        draftApplyConflict: '目标技能已变更，草稿未应用。',
        draftApplyMissing: '此草稿已不可用。', draftApplyCancelled: '已取消应用草稿。',
        draftApplyUnresolved: '此技能先前的写入仍待核验。',
        draftApplyWriteUnconfirmed: '尚未核验此次写入。请查看提案状态后再重试。',
        preservedVersions: '已保存版本与恢复', no_change: '无需修改',
        correctionWords: '纠正短语（每行一个）', curatorScope: '生命周期操作仅适用于此插件纳管的私有技能。',
        metric: '指标', value: '数值', advanced: '高级设置', nextScan: '下次检查', connection: 'OpenViking 连接', reuse: '使用当前连接经 OpenViking 核验的用户身份。', configuredWriter: '使用已配置的 OpenViking 连接。', localDrafts: '改进会保存在本机。连接 OpenViking 记忆插件后，可将改进写回技能库。', modelSelection: '如需指定复盘模型，请填写 DSH 模型设置中的提供商 ID 和模型 ID。任一项留空时，复盘沿用来源会话的模型。', modeHelp: '选择 DSH 学到值得保留的经验后，如何更新技能。', cooldownMinutes: '自动复盘最短间隔（分钟）',
         effectiveMode: '当前实际行为', autoHelp: '符合条件的改进会自动写入你的私有技能，并保留可恢复的版本。',
         approvalHelp: '先向你展示改进，确认后才更新技能。', shadowHelp: '把改进保存在本机，供你查看。', offHelp: '暂停技能复盘和学习。',
      },
    };
    const known = (t, key) => Object.hasOwn(dictionaries.en, key) ? t(key) : key;
    const rows = value => Array.isArray(value) ? value : [];
    const confirmCopy = {
      approve: 'confirmApprove', reject: 'confirmReject', rollback: 'confirmRollback',
      archive: 'confirmArchive', restore: 'confirmRestore',
      clearProposals: 'confirmClearProposals', clearHistory: 'confirmClearHistory',
    };

    async function requestDashboard(signal, operation, sessionId) {
      const send = window.__DSH_TRANSPORT__?.fetch ?? window.fetch.bind(window);
      const path = !operation && sessionId ? `${endpoint}?sessionId=${encodeURIComponent(sessionId)}` : endpoint;
      const response = await send(path, {
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

    function Card({ title, controls, children }) {
      return h('section', { className: 'ove-card' },
        controls ? h('div', { className: 'ove-row' }, h('h2', null, title), controls) : h('h2', null, title), children);
    }

    function localDate(value) {
      if (typeof value !== 'string' && typeof value !== 'number') return value;
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
    }

    function displayValue(key, value) {
      return dateFields.has(key) ? localDate(value) : value;
    }

    function LatestList({ kind, items, renderItem, t }) {
      const list = entries => h('ul', { className: 'ove-list' }, entries.map(renderItem));
      const older = items.slice(3);
      return h('div', { 'data-ove-list': kind }, list(items.slice(0, 3)),
        older.length > 0 && h('details', { className: 'ove-more' },
          h('summary', { onKeyDown: activateOnEnter }, `${t('older')} (${older.length})`), list(older)));
    }

    function Value({ value, t }) {
      if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
        return h('pre', { className: 'ove-code' }, JSON.stringify(value, displayValue, 2));
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
        h('dt', null, known(t, key)), h('dd', null, h(Value, { value: displayValue(key, value), t })))));
    }

    function shortSkillName(uri) {
      return uri.split('/').filter(Boolean).at(-2) ?? uri;
    }

    function Usage({ data, t }) {
      const skills = rows(data?.skills).filter(item => typeof item?.uri === 'string')
        .sort((a, b) => (Date.parse(b.lastUsed) || Number(b.lastUsed) || 0) - (Date.parse(a.lastUsed) || Number(a.lastUsed) || 0));
      return skills.length ? h(LatestList, { kind: 'usage', items: skills, t, renderItem: item =>
        h('li', { key: item.uri, className: 'ove-row' },
          h('div', null, h('strong', { title: item.uri }, shortSkillName(item.uri)),
            item.lastUsed != null && h('p', { className: 'ove-muted' }, `${t('lastUsed')} · ${localDate(item.lastUsed)}`)),
          h('span', null, `${t('skillLoads')} · ${(item.loads ?? 0).toLocaleString()}`)),
      }) : h('p', { className: 'ove-muted' }, t('noSkillUsage'));
    }

    const memoryStates = {
      linked: 'memoryLinked', unobserved: 'memoryUnobserved', initializing: 'memoryInitializing',
      excluded: 'memoryExcluded', unavailable: 'memoryUnavailable', no_session: 'memoryNoSession',
    };
    const memoryConnections = {
      observed: 'memoryObserved', configured: 'memoryConfigured', disabled: 'memoryOff', unavailable: 'memoryUnavailable',
    };

    function Memory({ data, t }) {
      const { connection, state, recall, capture, experiences } = data ?? {};
      const enabled = value => value === true ? 'memoryOn' : value === false ? 'memoryOff' : 'memoryUnknown';
      const summaries = [
        [t('memoryLink'), t(memoryConnections[connection] ?? 'memoryUnknown')],
        [t('memorySession'), t(memoryStates[state] ?? 'memoryUnknown')],
      ];
      if (recall?.enabled != null) {
        summaries.push([t('memoryRecall'), t(enabled(recall.enabled))]);
        if (recall.enabled && recall.scope) summaries.push([t('memoryScope'), t(recall.scope === 'actor' ? 'memoryActor' : 'memoryAll')]);
      }
      if (capture?.enabled != null) {
        summaries.push([t('memoryCapture'), t(enabled(capture.enabled))]);
        if (capture.enabled && capture.toolResultsEnabled != null) summaries.push([t('memoryTools'), t(enabled(capture.toolResultsEnabled))]);
        if (capture.hasPendingWrites != null) summaries.push([t('memoryWriteState'), t(capture.hasPendingWrites ? 'memoryQueued' : 'memoryNoneQueued')]);
      }
      const technical = {
        dshSessionId: data?.dshSessionId, ovSessionId: data?.ovSessionId, peerId: data?.peerId,
        lastInjectedSeq: recall?.lastInjectedSeq, lastProfileSeq: recall?.lastProfileSeq,
        lastCommitBoundarySeq: capture?.lastCommitBoundarySeq, remoteCommit: state === 'linked' ? capture?.remoteCommit : null,
      };
      const activity = rows(experiences).filter(item => typeof item?.uri === 'string').slice().reverse();
      return h(React.Fragment, null,
        h('dl', { className: 'ove-facts ove-memory-summary' }, summaries.map(([label, value]) =>
          h(React.Fragment, { key: label }, h('dt', null, label), h('dd', null, value)))),
        activity.length > 0 && h('details', { className: 'ove-more' },
          h('summary', { onKeyDown: activateOnEnter }, `${t('memoryExperiences')} (${activity.length})`),
          h('ul', { className: 'ove-list' }, activity.map((item, i) => h('li', { key: `${i}:${item.uri}` },
            h('span', { title: item.uri }, item.uri.split('/').at(-1)), ' · ', t(item.kind === 'injection' ? 'memoryInjected' : 'memoryRecalled'))))),
        Object.values(technical).some(value => value != null) && h('details', { className: 'ove-more' },
          h('summary', { onKeyDown: activateOnEnter }, t('technicalDetails')), h(Facts, { data: technical, t })));
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
      const currentSession = useRef(currentSessionId);
      currentSession.current = currentSessionId;
      const [data, setData] = useState(null);
      const latestData = useRef(null);
      latestData.current = data;
      const [error, setError] = useState('');
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState('');
      const [refreshing, setRefreshing] = useState(false);
      const [session, setSession] = useState('');
      const [uri, setUri] = useState('');
      const [draft, setDraft] = useState(null);
      const [preview, setPreview] = useState(null);
      const [confirmation, setConfirmation] = useState(null);
      const [approvalInFlight, setApprovalInFlight] = useState(null);
      const [lastApprovalId, setLastApprovalId] = useState(null);
      const [batch, setBatch] = useState(null);
      const processedDisclosure = useRef(null);
      const managedSkills = useRef(null);
      const curatorScope = useRef(null);
      const skillFocus = useRef(null);
      const connection = useRef(null);
      const pending = useRef(false);
      const reading = useRef(null);

      async function refresh(signal = connection.current?.signal, fresh = false, manual = false) {
        if (!signal || signal.aborted || (!fresh && reading.current?.signal === signal)) return;
        const read = { signal, manual: manual || (reading.current?.signal === signal && reading.current.manual) };
        reading.current = read;
        if (manual) setRefreshing(true);
        try {
          const next = await requestDashboard(signal, undefined, currentSession.current);
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
        let timer;
        const schedule = () => {
          const records = rows(latestData.current?.proposals).concat(rows(latestData.current?.preservedVersions));
          const delayMs = records.some(autoVerificationActive) ? 2_000 : 15_000;
          timer = setTimeout(() => {
            if (!pending.current && document.visibilityState !== 'hidden') void refresh(controller.signal);
            if (!controller.signal.aborted) schedule();
          }, delayMs);
        };
        schedule();
        return () => { clearTimeout(timer); controller.abort(); };
      }, []);

      useEffect(() => { void refresh(connection.current?.signal, true); }, [currentSessionId]);

      useEffect(() => {
        if (approvalInFlight && busy !== 'approveAll') processedDisclosure.current?.querySelector('summary')?.focus();
      }, [approvalInFlight, busy]);

      useEffect(() => {
        if (busy || !skillFocus.current) return;
        const row = skillFocus.current;
        skillFocus.current = null;
        if (document.activeElement !== row && (row.isConnected || document.activeElement !== document.body)) return;
        const list = managedSkills.current;
        const next = list?.open && row.isConnected ? row.querySelector('button[data-ove-skill-action]:enabled') : null;
        (next || list?.querySelector('summary') || curatorScope.current)?.focus();
      }, [busy]);

      function beginApproval(id, status = 'applying') {
        setApprovalInFlight({ id, status });
        setLastApprovalId(id);
        setPreview(previous => previous?.id === id ? null : previous);
      }

      function applyApprovalResult(action, id, status) {
        if (!approvalStates.has(status) && (action !== 'approve' || status !== 'conflict')) return;
        const updateRows = items => rows(items).map(item => {
          if (item.id !== id) return item;
          const actions = ['preview'];
          if (status === 'applied') actions.push('rollback');
          if (status === 'pending') actions.push('approve', 'reject');
          if (status === 'applying' || status === 'restoring' || unconfirmedStates.has(status)) actions.push('verifyWrite');
          return { ...item, status, actions, history: [] };
        });
        setData(previous => ({ ...previous, proposals: updateRows(previous?.proposals),
          preservedVersions: updateRows(previous?.preservedVersions) }));
      }

      async function run(action, input, verifying = false) {
        const signal = connection.current?.signal;
        if (!signal || signal.aborted || pending.current) return;
        pending.current = true;
        const skillTransition = Object.hasOwn(skillTransitions, action) ? skillTransitions[action] : null;
        const skillNotice = skillTransition ? { action, uri: input.uri } : null;
        setBusy(action);
        setConfirmation(null);
        setNotice(skillNotice);
        if (action !== 'preview') setBatch(null);
        const approving = action === 'approve' || action === 'applyDraft' || action === 'verifyWrite';
        if (approving) {
          if (processedDisclosure.current) processedDisclosure.current.open = false;
          beginApproval(input.id, verifying || action === 'verifyWrite' ? 'verifying_write' : 'applying');
        }
        try {
          const reply = await requestDashboard(signal, { action, input });
          if (signal.aborted) return;
          if (action === 'preview') setPreview({ id: input.id, value: reply });
          else {
            if (action === 'settings') setDraft(null);
            if (reply?.status === 'proposals_cleared') {
              setPreview(null);
              setLastApprovalId(null);
            }
            if (approving) {
              applyApprovalResult(action, input.id, reply?.status);
              setApprovalInFlight(null);
            }
            if (skillTransition) {
              if (reply === skillTransition.status) {
                setData(previous => ({ ...previous, curator: { ...previous.curator, skills: rows(previous.curator?.skills).map(item =>
                  item.uri === input.uri ? { ...item, status: reply, actions: [skillTransition.nextAction] } : item) } }));
                setNotice({ ...skillNotice, message: skillTransition.success });
              } else {
                setNotice({ ...skillNotice, error: reply === 'out_of_scope' ? 'skillOutOfScope' : 'operationFailed' });
              }
            } else setNotice({ result: reply, action });
            await refresh(signal, true);
          }
        } catch (cause) {
          if (!signal.aborted) {
            setNotice({ ...skillNotice, error: Object.hasOwn(dictionaries.en, cause.message) ? cause.message : 'network' });
            if (approving) {
              setApprovalInFlight(null);
              await refresh(signal, true);
            }
          }
        } finally {
          pending.current = false;
          if (!signal.aborted) setBusy('');
        }
      }

      const enabled = action => !error && data?.capabilities?.[action] === true;
      const batchTargets = rows(data?.proposals).flatMap(item => {
        const action = item.status === 'pending' ? 'approve'
          : item.status === 'shadow' && !item.applyBlockedReason ? 'applyDraft' : null;
        return action && enabled(action) && rows(item.actions).includes(action)
          ? [{ id: item.id, title: item.title ?? item.uri ?? item.id, action }] : [];
      });

      async function approveAll() {
        const signal = connection.current?.signal;
        if (!signal || signal.aborted || pending.current || !batchTargets.length) return;
        pending.current = true;
        setBusy('approveAll');
        setConfirmation(null);
        setNotice(null);
        setBatch({ kind: 'approve', total: batchTargets.length, results: [] });
        if (processedDisclosure.current) processedDisclosure.current.open = false;
        try {
          for (const { id, title, action } of batchTargets) {
            if (signal.aborted) return;
            beginApproval(id);
            let status, errorKey;
            try {
              const reply = await requestDashboard(signal, { action, input: { id } });
              if (signal.aborted) return;
              status = reply?.status;
              applyApprovalResult(action, id, status);
            } catch (cause) {
              if (signal.aborted) return;
              errorKey = Object.hasOwn(dictionaries.en, cause.message) ? cause.message : 'network';
            }
            setBatch(previous => ({ ...previous, results: [...previous.results, { id, title, action, status, errorKey }] }));
          }
          setApprovalInFlight(null);
          await refresh(signal, true);
        } finally {
          pending.current = false;
          if (!signal.aborted) setBusy('');
        }
      }

      async function verifyAll() {
         const signal = connection.current?.signal;
         if (!signal || signal.aborted || pending.current || !verificationQueue.length) return;
         const targets = verificationQueue.map(item => ({ id: item.id, title: item.title ?? item.uri ?? item.id }));
         pending.current = true;
         setBusy('verifyAll');
         setConfirmation(null);
         setNotice(null);
         setBatch({ kind: 'verify', total: targets.length, results: [] });
         try {
           for (const { id, title } of targets) {
             if (signal.aborted) return;
             beginApproval(id, 'verifying_write');
             let status, errorKey;
             try {
               const reply = await requestDashboard(signal, { action: 'verifyWrite', input: { id } });
               if (signal.aborted) return;
               status = reply?.status;
               applyApprovalResult('verifyWrite', id, status);
             } catch (cause) {
               if (signal.aborted) return;
               errorKey = Object.hasOwn(dictionaries.en, cause.message) ? cause.message : 'network';
             }
             setBatch(previous => ({ ...previous, results: [...previous.results, { id, title, action: 'verifyWrite', status, errorKey }] }));
           }
           setApprovalInFlight(null);
           await refresh(signal, true);
         } finally {
           pending.current = false;
           if (!signal.aborted) setBusy('');
         }
       }

       function actionButton(action, input, label = action) {
         const wireAction = label === 'verifyWrite' ? 'verifyWrite' : action;
        return h(Button, { key: action + ':' + wireAction, disabled: !!busy || !enabled(wireAction),
          'data-ove-skill-action': Object.hasOwn(skillTransitions, action) ? action : undefined,
          onKeyDown: Object.hasOwn(skillTransitions, action) || action === 'preview' || action === 'applyDraft' || wireAction === 'verifyWrite'
            ? activateOnEnter : undefined,
          onClick: () => {
          if (confirmCopy[action] || wireAction === 'verifyWrite') setConfirmation({ action: wireAction, input, copy: wireAction === 'verifyWrite' ? 'confirmVerifyWrite' : confirmCopy[action] });
          else void run(wireAction, input);
        } }, t(label));
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
        for (const [key, { scale, min, max }] of Object.entries(numericFields)) {
          if (!Object.hasOwn(input, key)) continue;
          const number = Number(input[key]);
          const value = scale === 1 ? number : Math.round(number * scale);
          if (String(input[key]).trim() === '' || !Number.isSafeInteger(value) || value < min || value > max) {
            setNotice({ error: 'badRequest' });
            return;
          }
          input[key] = value;
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
      const withApprovalProgress = items => rows(items).map(item => item.id === approvalInFlight?.id
        ? { ...item, status: approvalInFlight.status, actions: [], history: [] } : item);
      const proposals = withApprovalProgress(data?.proposals);
      const pendingProposals = proposals.filter(item => item.status === 'pending' || item.status === 'shadow');
      const processedProposals = proposals.filter(item => item.status !== 'pending' && item.status !== 'shadow');
      const preservedVersions = withApprovalProgress(data?.preservedVersions);
      const awaitingVerification = item => item.id !== approvalInFlight?.id && canVerifyWrite(item);
      const proposalVerificationQueue = processedProposals.filter(awaitingVerification);
      const preservedVerificationQueue = preservedVersions.filter(awaitingVerification);
      const verificationQueue = [...proposalVerificationQueue, ...preservedVerificationQueue];
      const showVerifyAll = verificationQueue.length > 0 && enabled('verifyWrite');
      const hasProposals = proposals.length > 0;
      const lastApproval = processedProposals.find(item => item.id === lastApprovalId);
      const history = rows(data?.history);
      function indexWarning(item) {
        if (item.status !== 'applied' && item.status !== 'rolled_back') return null;
        const events = rows(item.history);
        const latest = events.findLastIndex(event => event.status === item.status);
        if (events[latest - 1]?.status !== 'index_unconfirmed') return null;
        return h('p', { className: 'ove-muted' }, t(item.status === 'applied' ? 'indexUnconfirmed' : 'removalIndexUnconfirmed'));
      }

      function confirmAction(scope, skillUri) {
        if (!confirmation) return null;
        const { action: name, input, copy } = confirmation;
        const proposalAction = proposalActions.includes(name);
        const lifecycleAction = Object.hasOwn(skillTransitions, name);
        const location = proposalAction ? 'proposal' : lifecycleAction ? 'skill' : name;
        if (scope !== location || (lifecycleAction && input.uri !== skillUri)) return null;
        const item = proposalAction && [...proposals, ...preservedVersions].find(row => row.id === input.id);
        const target = lifecycleAction ? null : item?.title ?? item?.uri ?? input.id;
        return h('section', { className: 'ove-message ove-controls', role: 'group', 'aria-label': t(copy) },
          h('span', null, t(copy), target ? ` ${target}` : ''),
          h(Button, { autoFocus: proposalAction || lifecycleAction,
            onKeyDown: lifecycleAction ? activateOnEnter : undefined,
            onClick: event => {
              if (lifecycleAction) {
                const row = event.currentTarget.closest('.ove-skill');
                (row?.querySelector('button[data-ove-skill-action]:enabled') || row)?.focus();
              }
              setConfirmation(null);
            },
          }, t('cancel')),
          h(Button, { primary: true, disabled: !!busy || !enabled(name),
            onKeyDown: lifecycleAction ? activateOnEnter : undefined,
            onClick: event => {
              if (lifecycleAction) {
                const row = event.currentTarget.closest('.ove-skill');
                skillFocus.current = row;
                row?.focus();
              }
              void run(name, input, copy === 'confirmVerifyWrite');
            },
          }, t('confirm')));
      }
      function lifecycleFeedback(collapsed = false) {
        if (!notice?.uri) return null;
        const message = notice.error ?? notice.message ?? (busy === notice.action ? skillTransitions[notice.action].progress : null);
        if (!message) return null;
        const label = collapsed ? `${notice.uri.split('/').at(-2)} · ` : '';
        return h('p', { role: notice.error ? 'alert' : 'status',
          className: collapsed ? 'ove-muted ove-collapsed-skill-feedback' : 'ove-muted' }, label, t(message));
      }

      function draftExplanation({ draftReason, applyBlockedReason }) {
        const reason = draftReasons.has(draftReason) ? draftReason : 'draft_legacy';
        const blocked = draftReasons.has(applyBlockedReason) || applyBlockedReason === 'draft_reviews_disabled' ? applyBlockedReason
          : applyBlockedReason === 'archived' ? 'draftApplyArchived' : 'draftApplyUnavailable';
        const stillBlocked = blocked === reason;
        return h(React.Fragment, null,
          h('p', { className: 'ove-muted' }, t(stillBlocked ? 'draftReasonStillBlocked' : 'draftReason'), ' · ', t(reason)),
          applyBlockedReason && !stillBlocked && h('p', { className: 'ove-muted' }, t('applyBlockedReason'), ' · ', t(blocked)));
      }

      const proposalRow = item => h('li', { key: item.id },
        h('div', { className: 'ove-row' }, h('div', null,
          h('strong', null, item.title ?? item.uri ?? item.id), ' ', h('span', { className: 'ove-status' },
            item.status === 'shadow' ? t('localDraft') : h(Value, { value: displayedProposalStatus(item), t })),
          item.createdAt != null && h('p', { className: 'ove-muted' }, localDate(item.createdAt)),
          item.summary && h('p', { className: 'ove-muted' }, item.summary),
          item.status === 'shadow' && draftExplanation(item), indexWarning(item)),
        h('div', { className: 'ove-controls' },
          proposalActions.filter(action => enabled(action) && (!Array.isArray(item.actions) ? action !== 'verifyWrite' : item.actions.includes(action)))
            .map(action => actionButton(action, { id: item.id }, action)),
          item.status === 'shadow' && !item.applyBlockedReason && enabled('applyDraft') && rows(item.actions).includes('applyDraft') &&
            actionButton('applyDraft', { id: item.id }))),
        preview?.id === item.id && h('div', { className: 'ove-preview' },
          h('div', { className: 'ove-row' }, h('h3', null, t('preview')), h(Button, { onClick: () => setPreview(null) }, t('close'))),
          h(Diff, { preview: preview.value, t })));
      const clearButton = (name, list) => list.length > 0 && enabled(name) && actionButton(name, { confirm: true });
      const clearNotice = action => notice?.action === action && notice.result?.status &&
        h('p', { role: 'status', className: 'ove-muted' }, known(t, notice.result.status));
      function batchResult() {
        if (!batch) return null;
        const format = (key, values) => t(key).replace(/\{(\w+)\}/g, (token, name) => values[name] ?? token);
        const done = batch.results.length;
        const verifying = batch.kind === 'verify';
        const completed = batch.results.filter(item => item.status === 'applied' || (verifying && item.status === 'rolled_back')).length;
        const verify = batch.results.filter(item => unconfirmedStates.has(item.status) ||
          ['applying', 'restoring', 'unresolved_write'].includes(item.status)).length;
        const other = done - completed - verify;
        return h('div', { className: 'ove-message' },
          h('p', { role: 'status' }, [format('batchProcessed', { done, total: batch.total }),
            format(verifying ? 'batchVerified' : 'batchApplied', { count: completed }), format('batchVerify', { count: verify }),
            format('batchOther', { count: other })].join(' · ')),
          done > 0 && h('details', null, h('summary', { onKeyDown: activateOnEnter }, t('batchDetails')),
            h('ul', { className: 'ove-list' }, batch.results.map(({ id, title, action, status, errorKey }) => {
              const label = errorKey ?? (action === 'applyDraft' ? draftApplyNotices.get(status) : status);
              return h('li', { key: id }, title, ' · ', t(Object.hasOwn(dictionaries.en, label) ? label : 'operationFailed'));
            }))));
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
        busy && !notice?.uri && h('p', { role: 'status', className: 'ove-message' }, t('working')),
        notice?.error && !notice.uri && h('p', { role: 'alert', className: 'ove-message' }, t(notice.error)),
        notice && !notice.error && !notice.uri && !notice.action?.startsWith('clear') && h('div', { className: 'ove-message', role: 'status' },
          h('strong', null, t('result')),
          notice.action === 'run' && notice.result?.status
            ? h(React.Fragment, null, ` · ${known(t, notice.result.status)}`,
              Object.keys(notice.result).some(key => key !== 'status') &&
                h(Facts, { data: Object.fromEntries(Object.entries(notice.result).filter(([key]) => key !== 'status')), t }))
            : notice.action === 'applyDraft'
              ? ` · ${t(draftApplyNotices.get(notice.result?.status) ?? 'draftApplyUnavailable')}`
              : notice.result === null ? ` · ${t('actionComplete')}` : h(Value, { value: notice.result, t })),
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
               h('p', { className: 'ove-muted' }, t('modelSelection')),
               h('p', { className: 'ove-muted' }, t('triggerHelp')),
               h('div', { className: 'ove-settings ove-settings-grid' }, [...Object.keys(numericFields), ...textFields].map(key => {
                 const numeric = numericFields[key];
                 const isPhrases = key === 'correctionWords';
                 const current = settings[key];
                 const value = draft?.[key] ?? (numeric && Number.isFinite(current) ? current / numeric.scale : current) ?? '';
                 return h('label', { key }, t(numeric?.label ?? settingsLabels[key] ?? key), h(isPhrases ? 'textarea' : 'input', {
                   ...(isPhrases ? { rows: 3 } : { type: numeric ? 'number' : 'text' }),
                   ...(numeric ? { min: numeric.min / numeric.scale, max: numeric.max / numeric.scale, step: numeric.scale === 1 ? 1 : 'any' } : {}),
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
            settings.mode !== 'off' && (!settings.provider?.trim() || !settings.model?.trim()) &&
              h('p', { className: 'ove-muted' }, t('usingSessionModel')),
            h(Facts, { t, data: Object.fromEntries(Object.entries(status).filter(([key]) => key !== 'state' && key !== 'status')) })),
          h(Card, { title: t('proposals'), controls: (hasProposals || showVerifyAll) && h('div', { className: 'ove-controls' },
            showVerifyAll && h(Button, { disabled: !!busy, onKeyDown: activateOnEnter, onClick: () => void verifyAll() }, t('verifyAll')),
            hasProposals && h(Button, { primary: true, disabled: !!busy || !batchTargets.length,
              onKeyDown: activateOnEnter, onClick: () => void approveAll() }, t('approveAll')),
            clearButton('clearProposals', proposals)) },
            confirmAction('proposal'), confirmAction('clearProposals'), clearNotice('clearProposals'), batchResult(),
            proposals.length ? h('div', { 'data-ove-list': 'proposals' },
              pendingProposals.length > 0 && h(LatestList, { kind: 'pending-proposals', items: pendingProposals, renderItem: proposalRow, t }),
              processedProposals.length > 0 && h('details', { className: 'ove-more', 'data-ove-processed': '', ref: processedDisclosure },
                h('summary', { onKeyDown: activateOnEnter }, `${t('processedProposals')} (${processedProposals.length})`,
                  proposalVerificationQueue.length > 0 && ` · ${t('needsVerification')} (${proposalVerificationQueue.length})`,
                  lastApproval && h('span', { role: 'status', className: 'ove-muted' }, ` · ${known(t, proposalStatus(lastApproval))}`)),
                proposalVerificationQueue.length > 0 && h('ul', { className: 'ove-list' }, proposalVerificationQueue.map(proposalRow)),
                h(LatestList, { kind: 'processed-proposals', items: processedProposals.filter(item => !awaitingVerification(item)), renderItem: proposalRow, t })))
              : h('p', { className: 'ove-muted' }, t('noProposals')),
            preservedVersions.length > 0 && h('details', { className: 'ove-more' },
              h('summary', { onKeyDown: activateOnEnter }, `${t('preservedVersions')} (${preservedVersions.length})`,
                 preservedVerificationQueue.length > 0 && ` · ${t('needsVerification')} (${preservedVerificationQueue.length})`),
              h(LatestList, { kind: 'versions', items: preservedVersions, renderItem: proposalRow, t }))),
          h(Card, { title: t('history'), controls: clearButton('clearHistory', history) },
            confirmAction('clearHistory'), clearNotice('clearHistory'),
            history.length ? h(LatestList, { kind: 'history', items: history, t, renderItem: (item, i) => h('li', { key: item.traceId ?? (item.id ?? '') + ':' + i },
              h('details', null, h('summary', null, localDate(item.at ?? item.startedAt) ?? item.id ?? '', ' ',
                h(Value, { value: item.status ?? item.state, t })), h(Facts, { data: item, t })),
            ) }) : h('p', { className: 'ove-muted' }, t('noHistory'))),
          h(Card, { title: t('curatorTitle') },
            h('p', { ref: curatorScope, tabIndex: -1, className: 'ove-muted' }, t('curatorScope')),
            h('div', { className: 'ove-controls' }, enabled('curator') && actionButton('curator', {}), enabled('adopt') && h('form', {
              className: 'ove-controls', onSubmit: event => { event.preventDefault(); if (uri.trim()) void run('adopt', { uri: uri.trim() }); },
            }, h('label', null, t('uri'), ' ', h('input', { value: uri, onChange: event => setUri(event.target.value), disabled: !!busy })),
            h(Button, { type: 'submit', disabled: !!busy || !uri.trim() }, t('adopt')))),
            curator.nextScan != null && h('p', { className: 'ove-muted' }, `${t('nextScan')} · ${localDate(curator.nextScan)}`),
            rows(curator.audit).length > 0 && h('details', null, h('summary', null, t('history')), h(Value, { value: curator.audit, t })),
            notice?.uri && !skillRows.some(item => item.uri === notice.uri) && lifecycleFeedback(),
            skillRows.length ? h('details', { ref: managedSkills, className: 'ove-more', 'data-ove-managed-skills': '' },
              h('summary', { onKeyDown: activateOnEnter }, `${t('managedSkills')} (${skillRows.length})`),
              h('ul', { className: 'ove-list' }, skillRows.map(item => h('li', { className: 'ove-skill', key: item.uri, tabIndex: -1 },
                h('div', { className: 'ove-row' },
                  h('div', null, h('strong', null, item.title ?? item.uri), ' ',
                    h('span', { className: 'ove-status' }, h(Value, { value: item.status, t }))),
                  h('div', { className: 'ove-controls' }, skillActions.filter(action => enabled(action) && (item.actions?.includes(action) ??
                    (action === (item.status === 'archived' ? 'restore' : 'archive')))).map(action => actionButton(action, { uri: item.uri })))),
                confirmAction('skill', item.uri),
                notice?.uri === item.uri && lifecycleFeedback(),
              )))) : h('p', { className: 'ove-muted' }, t('noSkills')),
            notice?.uri && skillRows.some(item => item.uri === notice.uri) && lifecycleFeedback(true)),
          h('div', { className: 'ove-pair' },
            h(Card, { title: t('skillUsage') }, h(Usage, { data: data.usage, t })),
            h(Card, { title: t('memory') }, h(Memory, { data: data.memory, t }))),
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
      .ove-card,.ove-message { min-width:0; display:grid; align-content:start; gap:10px; border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4)); padding:14px; border-radius:12px; background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2)); }
      .ove-message.ove-controls { display:flex; }
      .ove-card label { display:inline-flex; align-items:center; flex-wrap:wrap; gap:7px; }
      .ove-muted,.ove-facts dt { color:var(--dsw-alias-text-secondary,currentColor); }
      .ove-status { display:inline-block; font-size:12px; border-radius:999px; padding:2px 7px; background:var(--dsw-alias-bg-layer-3); }
      .ove-dashboard :is(button,input,select,textarea) { border:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4)); border-radius:7px; color:inherit; background:var(--dsw-alias-bg-layer-3); padding:5px 8px; font:inherit; }
      .ove-settings { display:grid; gap:10px; }
      .ove-settings-grid { margin-top:10px; grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr)); }
      .ove-settings label { display:grid; grid-template-rows:auto 1fr; align-content:start; min-width:0; }
      .ove-dashboard :is(.ove-advanced,.ove-more):not([open]) > :not(summary) { display:none; }
      .ove-more { margin-top:8px; }
      .ove-more[open] > summary { margin-bottom:8px; }
      [data-ove-managed-skills][open] + .ove-collapsed-skill-feedback { display:none; }
      .ove-collapsed-skill-feedback { overflow-wrap:anywhere; }
      .ove-advanced > p { margin-top:8px; }
      .ove-settings textarea { resize:vertical; }
      .ove-settings > .ove-controls { grid-column:1 / -1; }
      .ove-memory-summary { grid-template-columns:minmax(0,1fr) minmax(0,1fr); }
      .ove-dashboard input { max-width:100%; }
      .ove-dashboard button:enabled,.ove-dashboard summary { cursor:pointer; }
      .ove-dashboard button:disabled { opacity:.48; }
      .ove-dashboard button.ove-primary { font-weight:650; border-color:currentColor; }
      .ove-dashboard :is(button,input,select,summary):focus-visible { outline:2px solid var(--dsw-alias-text-primary,currentColor); outline-offset:2px; }
      .ove-list { display:grid; gap:8px; padding:0; margin:0; list-style:none; }
      .ove-list > li { border-top:1px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l4)); padding-top:8px; overflow-wrap:anywhere; }
      .ove-skill { display:grid; gap:8px; }
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
