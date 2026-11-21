# Project notes

## 2026-11-20 · M0 接入核验通过

- 工作区为本地 `main`，初始无提交。宿主 manifest 为 `@deepseek-ai/dsh 0.2.2-rc.3`，Desktop 的 ASAR 通过同版 Electron 44.7.0 的 `ELECTRON_RUN_AS_NODE=1` 读取和启动。
- 固定上游 [hermes-loop v0.3.2](https://github.com/weibaohui/hermes-loop/tree/6ce02f45dc489a9fad4ab71f55d488b01ac294ed)。对照 README、`src/index.js`、`client/bundle.js` 与 `test/loop.test.mjs`。固定基线包含手动复盘、10 轮或 10 次工具调用、30 分钟冷却、三种写入模式与独立 Curator。此轮根据行为重写，未复用上游源码。
- 安装版 `dsh-commands/lib/index.js` 的 `ctx.commands.register({ name, description, input, handler })` 接受 `handler({ agent, rawInput, signal })`。`ctx.commands.execute(agent, line, [], signal)` 返回 `{ commandId, result }` 并写入 `command/run`、`command/done` 两个 log-only 事件。`ctx.sessionProjections.register(definition)` 返回可等待的注册句柄，`stateOf(session)` 折叠已提交事件并可在重放时重建。`session/event` 是提交后观察入口。新实现用投影，避开已弃用的 `snapshotEvents()`、`ownEvents()` 与 `eventAt()`。
- 安装版 `dsh-tools/lib/pipeline.js:188–212` 持久化 `tool/call.data.{callId,name,arguments}`，`tool/result.data.message` 包含 `source.callId`、`isError` 和内容。`dsh-mcp-client/lib/index.js:565–605` 将 MCP 文本结果投影到工具消息，`isError` 会成为失败。`dsh-agent/lib/index.js:582` 公开 `ctx.agents.create()`，`ctx.llm.stream()` 是模型辅助请求入口，需让模型输入可从日志重建。两条模型执行路线已核源码，本轮未调用模型。
- 本机 OV Memory 插件 manifest 为 `0.5.31`，`mcp.mjs` 复用 DSH MCP bridge，`mcp-env.mjs` 使用现有 OV 连接。已实测部署实例 MCP `health`、私有技能 canonical URI 全量单读、私有 URI 缺失返回 `NOT_FOUND`，以及共享目录列表为空。全量单读是无 URI 标头的 Markdown，批量读有标头且可能逐 URI 报错。会话启动目录注入、原生本地引导技能 provider 和远端正文读取是不同路径。既有会话目录刷新的行为仍待测。部署服务端版本、写权限、附件、索引、PUT/audit 与原子条件更新均未实测。公开接口参考 [OpenViking Skills API](https://docs.openviking.ai/en/api/04-skills)。
- `python3 test/host-smoke.py` 通过。脚本以临时 `DSH_HOME`、清洁环境和回环随机端口启动同版 `web`，由 overlay 加载探针。探针在真实 Cordis 挂载分支中加载插件，验证 `/skill-refine` 注册、执行和提交事件，调用分支 `dispose()`，随后验证命令无注册且不可执行。隔离进程随测试退出。包管理器安装、卸载及 GUI 图标展示尚未验证。

## M1 · 手动影子复盘通过隔离事件夹具

- `/skill-refine` 列出本会话可绑定的读取事件及序号。`/skill-refine <canonical-skill-uri>` 只产出结构化 `create`、`patch` 或 `no_change`。规则审阅独立于主模型，使用显式纠正或显式经验，不推测自由文本中的意图。
- 修订提案要求同一会话成功完成 OV 全量单读，并有随后提交的用户纠正引用该读取结果。提案附完整 URI、读取文本的 SHA-256、调用及结果序号、纠正序号、原因与单行 unified diff。保留 frontmatter，拒绝歧义匹配。显式新建经验只产出私有路径候选，存在性标记 `unverified`。
- `npm test` 通过 8 项，覆盖小幅修订、无学习证据、同名作用域、失败或部分读、会话内旧版本、身份不明的别名、重复触发、新建与 fork 继承边界。`python3 test/host-smoke.py` 另在真实宿主提交合成的读取和用户纠正事件，得到 `patch`，紧接着复触发得到 `no_change/duplicate`。插件仅注册命令与证据投影，影子复盘没有 OV 请求或写入口。OpenViking 的项目笔记同步属于独立的开发记录。
- 已验证的旧版本行为以本会话后来观察到的不同正文为准。部署端在两次读取之间的未观察修改、MCP 从传输到事件的隔离端到端链路、浏览器命令入口、重启后的去重和任意自然语言审阅未验。当前投影保留最近 160 条相关证据，最多绑定 24,000 字符的单读结果。
- 最小复现：先从会话用 `mcp__openviking__read` 按 canonical URI 无 `limit` 地读取技能。运行 `/skill-refine` 获取 `readResultSeq`，提交下列四行的用户消息，再运行 `/skill-refine <canonical-skill-uri>`。

```text
技能纠正 <readResultSeq>
原文：<技能正文中唯一的整行>
改为：<替换后的整行>
原因：<从本会话得到的纠正理由>
```

- 新建证据使用 `技能经验 <canonical-private-skill-uri>`，随后三行依次为 `描述：…`、`步骤：…`、`原因：…`。同会话调用上述带 URI 的命令查看提案。

## M1 · 隔离 Web 只读集成验收通过

- 实测宿主为 Desktop `0.2.2-rc.3` 的 Web profile。临时目录隔离 `DSH_HOME`、`DSH_AGENTS_HOME`、Documents、工作目录和会话持久化。模型使用确定性进程内适配器，OpenViking 一端使用本地 stdio 只读协议夹具。Web 消息经过实际 Agent Loop、DSH MCP 客户端和工具管线，由宿主提交事件。观察器只记录事件与摘要。
- 浏览器从输入框调用 `/skill-refine`，可以发现命令并看到列表和 JSON 结果。私有 `viking://user/fixture/skills/demo/SKILL.md` 的 `tool/call` seq 29 与 `tool/result` seq 30 共享 call ID `fixture-eddc19fb-c71e-47b5-899c-4b4bcfe6d75b`。夹具正文、事件正文和提案基线的 SHA-256 一致，为 `201237f3ce12338cef29078b84190df268c06f91e46b4492ea28f85e8b4de127`。纠正 seq 42 生成单行 diff `Run smoke.` → `Run smoke and check exit status.`，提案 seq 47。
- 同一进程再次执行 seq 49 与重启后从侧栏恢复同一会话的 seq 52，均返回 `no_change/duplicate`，`previousProposalId` 均为 `d9b9d731223b7e4b45297809aa85528c21c1d8dc04ae80ea4eede0019b9f4884`。同名共享技能读取 seq 62 有独立 URI 和摘要，私有纠正没有进入共享提案。缺失结果 seq 77 的 `isError=true`，返回 `latest_read_unusable`。同会话读取不同版本 seq 105 后返回 `stale_read`。`limit: 4` 的部分结果 seq 120 成功传回但未计入可绑定列表，返回 `latest_read_unusable`。
- MCP 请求日志与宿主事件逐项核对，只有 6 次预期 `read` 和启动握手，9 次复盘均未额外调用 MCP。技能写入为 0。`python3 test/verify-integration.py <临时证据目录>`、`npm test`（8/8）、`python3 test/host-smoke.py` 均通过。
- 本轮尚未验证真实 OV 服务端经隔离 DSH 的连接、带附件包及元数据、远端目录注入和刷新、传输层无标记截断。`limit: 4` 证明的是显式分页产生的部分读。无标记且语法完整的短正文缺少独立完整性证据。真实部署的单读和缺失行为见 M0。自然语言独立审阅及跨会话版本变化仍未验。

### 复现实测

1. 设置 `DSH_INSTALL_DIR` 与 `DSH_NODE_EXECUTABLE` 指向本机 DSH 包和匹配的 Electron 可执行文件，运行 `python3 test/integration-host.py`。使用临时证据目录中 `host-1.log` 打印的完整认证 URL 打开 Web。
2. 在一个新会话依次发送 `Fixture read private` 和 `/skill-refine`，获取实际读取序号。按上文四行格式发送纠正，将 `Run smoke.` 改成 `Run smoke and check exit status.`，原因为 `Verify the result.`。连续两次发送 `/skill-refine viking://user/fixture/skills/demo/SKILL.md`。
3. 在启动脚本的终端输入 `restart`，打开新日志的认证 URL，通过侧栏恢复原会话。再次发送私有复盘命令。发送 `Fixture read shared`，然后复盘 `viking://agent/skills/demo/SKILL.md`。发送 `Fixture read missing`，然后复盘 `viking://user/fixture/skills/missing/SKILL.md`。
4. 连续发送两次 `Fixture read private` 后复盘私有 URI。发送 `Fixture read partial` 后再次复盘私有 URI，最后发送 `/skill-refine`。验证日志后在启动终端输入 `quit` 关闭宿主并清理临时目录。

## 首次本地提交复核

独立审阅发现两个 M1 边界问题。若后续批量读取包含同一技能，现有投影会略过整次调用，旧单读仍可能生成提案。单行 diff 在 CRLF 文件中丢失行尾的 CR 字符，末行无换行时也缺少相应标记。将当前版本保存为只读阶段基线。M2 可以先在隔离 OV 做接口探针。将提案接入写回前，需修复这两个问题并加入回归测试。

## 2026-11-20 · M2 隔离审批写回与恢复验收通过

- 修复 M1 两个写入前置问题。后续批读包含目标时，旧单读基线失效。单行 diff 保留 CRLF 和末行无换行语义，两种补丁均以真实 `git apply --unidiff-zero` 验证。投影版本升至 2，已有 v1 缓存的升级重放仍待验证。
- 默认仍为影子模式。启用 `approval` 后只纳管一个明确指定的私有 canonical URI。使用 `/skill-refine <URI>` 取得 `proposalId` 与 `approvalDigest`。在原会话用 `/skill-approve <ID> <digest>`、`/skill-reject <ID> <digest>` 或 `/skill-rollback <ID> <digest>` 操作。审批摘要绑定已展示提案和整包变更前后摘要。账本持久化状态和恢复快照，写前重读并比较正文、来源与附件。遇到请求结果不确定时，重复命令只做回读确认。
- `npm test` 通过 22 项，覆盖未知基线、预览后改动正文或附件、错误会话或摘要、拒批、重复审批、超时后读回、索引未确认和回滚冲突。`python3 test/host-smoke.py` 在 DSH Desktop `0.2.2-rc.3` 临时 profile 验证命令注册、预览零写入、审批去重、回滚和卸载，写端使用进程内夹具。`git diff --check` 与 `npm pack --dry-run --ignore-scripts` 通过。
- [原生接口探针](<docs/m2-api-probe.md>) 使用 OpenViking `0.5.5` 与临时账户、存储及回环推理。附加 `--approval-probe test/approval-real.mjs` 的完整运行退出码为 0。通过真实 HTTP 整包审批和恢复，分别回读正文 SHA-256 `f52b2605587c1076230afb9d3c586ebe8248e8017ce3313a540899cecaabe411` 与 `dac5696f5f03b1017f6750c3751a77d1646bb681b4d3e1a491ab90d954f0936d`。逐字节核对 `assets/blob.bin`、`refs/steps.txt` 及来源元数据，并确认按私有 canonical URI 可检索。原生接口探针另验证描述变化可反映到索引和私有写入保持同名共享包不变。
- OpenViking `0.5.5` 接受陈旧 `If-Match`，客户端超时后也曾观察到写入完成。当前真实写端限定于显式配置的回环单写者实例，单写者由运行环境保证。当前确认范围为普通技能包内容、附件、来源元数据和索引可检索性。跨端并发、部署实例写入、独立隐私配置和 ACL 恢复尚未验证。

## 后续验收

## 2026-11-20 · M3 MVP 端到端通过

- 使用本机 DSH Desktop `0.2.2-rc.3` 的正常 Web 会话入口和临时 profile，连接独立 OpenViking `0.5.5` 的 `/mcp`（Streamable HTTP）与技能 REST API。测试账号 `alice` 只操作一个私有夹具技能。DSH 模型使用确定性适配器，从每次 MCP 返回的正文提取步骤，便于独立验证行为。
- 首次 Web 复盘返回 `no_learning_evidence`，事件证实原生 MCP 使用单数 `uri`，既有测试后端使用 `uris`。证据投影现支持两种输入，含糊的双字段请求仍会跳过。重启隔离 DSH 后，原会话读取事件 17/19 和纠正事件 29 生成同一夹具的一行补丁。复盘、审批与回滚分别记录为事件 37、39、41，状态依次为 `pending`、`applied`、`rolled_back`。
- 三个独立会话通过同一 MCP URI 分别读到旧版、新版、恢复的旧版。页面输出分别是 `Skill step: Run smoke.`、`Skill step: Run smoke and check exit status.`、`Skill step: Run smoke.`。SHA-256 依次为 `dac5696f5f03b1017f6750c3751a77d1646bb681b4d3e1a491ab90d954f0936d`、`f52b2605587c1076230afb9d3c586ebe8248e8017ce3313a540899cecaabe411`、`dac5696f5f03b1017f6750c3751a77d1646bb681b4d3e1a491ab90d954f0936d`。
- 审批与回滚成功状态均经过写后整包快照及索引核对。独立校验通过真实 REST 列表、详情、下载和搜索，核实私有目录唯一命中、源元数据还原，`assets/blob.bin` 和 `refs/steps.txt` 逐字节一致，恢复后 revision 为 `8e91d456e77b6387ddd16f7c32a30288115ce5bd7258d83886c2d8b655bc84d6`。搜索确认目标可发现，正文版本由 MCP 读取哈希证明。
- `npm test` 23/23，`python3 -B test/host-smoke.py` 通过，`git diff --check` 通过。隔离服务在验收后退出。

### 复现

1. 使用 OpenViking 0.5.5 对应 venv，设置 `DSH_NODE_EXECUTABLE` 为 Desktop Electron 可执行文件，`DSH_INSTALL_DIR` 为该安装中 `@deepseek-ai/dsh` 根目录。运行 `python -B test/ov-m2-probe.py --server-bin /path/to/openviking-server --web`。进程输出临时证据目录，Web URL 在该目录 `host-1.log` 首行。把 URL 中的令牌仅留在本机夹具。
2. 在 Web 新会话发送 `Fixture use skill`。从证据目录的 `events.jsonl` 读取对应成功 `tool/result` 的 `seq`。发送四行纠正，依次为 `技能纠正 <seq>`、`原文：Run smoke.`、`改为：Run smoke and check exit status.`、`原因：核对退出状态。`。执行 `/skill-refine viking://user/alice/skills/ov-m2-probe-fixture/SKILL.md`。
3. 在原会话执行 `/skill-approve <proposalId> <approvalDigest>`，确认 `applied`。在新会话重发 `Fixture use skill`，确认新版。回到原会话执行 `/skill-rollback <proposalId> <approvalDigest>`，确认 `rolled_back`。再建一个会话重发 `Fixture use skill`，确认旧版。
4. 服务运行期间执行 `python -B test/verify-m3.py <临时证据目录>`。通过后在启动终端输入 `quit`。

本轮验收覆盖隔离单写者路径。实际模型理解和执行技能、日用 profile、多人并发与生产写回仍待单独验证。OpenViking 0.5.5 实测缺乏可用的条件写回，推广到多写者环境前应以服务端条件更新为前置。

## 2026-11-22 · P0 基线复核与真实模型冒烟准备

- 独立复核发现两项写回风险：整包更新可能影响技能的独立隐私配置；审批等待队列时被取消仍可能写入。隔离适配器现在通过 `/api/v1/privacy-configs/skill` 检查目标名，不取密钥值；存在隐私配置、写入候选含隐私引用或检查结果异常时停止。审批执行权到手时、写前和临时包上传后重新检查取消状态。已发出的 PUT 仍按不确定写入处理并回读，取消不保证撤销服务端已接受的请求。
- 24 项 Node 测试、隔离 DSH 冒烟、OpenViking 0.5.5 原生审批和回滚均通过。原生探针先添加合成隐私字段，确认审批被拦截而字段仍在，移除测试字段后确认审批和回滚正常。
- 真实模型冒烟入口：保持临时 DSH profile、测试技能及只读 MCP，不连接日用 OpenViking，不启用审批。用独立测试凭据从本机启动环境设置 `DEEPSEEK_API_KEY`，同时设 `SKILL_EVOLUTION_P0_MODEL=deepseek-flash`，沿用 M3 的 DSH 两个安装路径变量，运行 `python3 -B test/integration-host.py`。密钥不要发到对话或写入仓库。模型必须通过 MCP 读到事先不在提示中的标记 `ORCHID-482` 并按技能答复；然后给出一条有实际改动的四行纠正，验证 `/skill-refine viking://user/fixture/skills/demo/SKILL.md` 的 diff。重启临时宿主并复查会话和去重；本机 MCP 轨迹中应只有读取请求。
- 当前启动环境未配置 `DEEPSEEK_API_KEY`，真实模型与日用 Desktop 试用尚未验收。未动日用 profile 或真实技能；日用只读加载需另行确认。
