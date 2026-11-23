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
- P0 证据校验：提示只给技能 URI，要求按技能返回指定标记，不在提示中放入标记；从 Web 回复确认 `ORCHID-482`。纠正旧行为 `Run smoke and report ORCHID-482.`，新行为 `Run smoke and report ORCHID-482 after checking exit status.`。生成提案后，在启动终端输入 `restart`，回到同一会话再运行一次 `/skill-refine`。服务退出前运行 `python3 -B test/verify-p0.py <临时证据目录>`，核对读结果哈希、精确补丁、跨进程去重及 MCP 零写入。检查器已用合成事件验证通过，并确认同一进程重复不会被误认作重启验证。另在默认夹具模式实测启动器连续启动两个不同端口的 Web 进程，`quit` 后临时目录已清理；这项验证不计作真实模型测试。
- 2026-11-22 真实模型只读冒烟通过。隔离 DSH Web 选择 `deepseek-official/deepseek-flash`，界面显示 DeepSeek-V4.1-Flash。提示只包含技能 URI 和查阅要求，模型发起 1 次 MCP 读取并回复正文中的 `ORCHID-482`。根据纠正生成了预期的一行补丁（首进程命令事件 34），重启宿主后在同一会话复盘识别为 `duplicate`。`test/verify-p0.py` 实测退出码 0，确认读结果哈希、精确补丁、两代进程及 0 次技能写入。会话 `session-8cad2cdb-1d04-4b89-90f6-4c77a0222262`，提案 `66e75264c67859e19b26281555d3566b30d8a42ad261c032a0daf9a39f05fa9c`。日用 Desktop 只读加载仍待单独确认。

## 2026-11-22 · v0.1.0 候选范围与验证

- P1 保留 `/skill-refine`，列出当前会话的 canonical URI、私有或共享范围、最近一次读取状态、可用正文的 SHA-256 和对应命令。四行纠正可以写 URI。插件检查纠正前最近一次读取是否完整且成功，再与会话后来读到的版本比较。旧事件编号格式仍受支持。
- P2 自动复盘延期。当前首发范围为手动提案，隔离审批与整包回滚仍为默认关闭的实验功能。服务端 `If-Match` 在 0.5.5 本机实测不具备原子条件更新的语义，因此生产写回和并发写回继续留待后续。
- P3 本机分别使用 Node v22.23.5、v24.22.3 和 v25.3.0 运行 `npm test` 与 `npm run test:release`。各运行时均为 26/26，实际 tarball 白名单及导出检查均通过。GitHub Actions 配置 Node 22/24 的单测与打包检查，远端运行待有发布仓库后验证。
- OpenViking 0.5.5 原生隔离审批和恢复回归再次通过。对应正文 SHA-256 为 `f52b2605587c1076230afb9d3c586ebe8248e8017ce3313a540899cecaabe411`、`dac5696f5f03b1017f6750c3751a77d1646bb681b4d3e1a491ab90d954f0936d`，两个附件及恢复后的检索结果均已核对。
- 发布设置待确认。候选包使用 `private: true` 标记，DSH 本地安装可用。仓库还未指定对外许可，参考项目只用于核对行为。公开渠道与许可由发布者确定。若选 npm，需调整发布锁并重新打包验收。
- P4 固定本地候选包 `dist/dsh-openviking-skill-evolution-0.1.0.tgz`，12,762 字节、13 个文件，SHA-256 `f0e0f6edab1f65675b43986f4db4206e7291ddbdca15ab0dc9af7e94c701c689`。在 macOS 的 DSH Desktop 0.2.2-rc.5 临时 Web profile 上，真实插件管理器安装并启用该包，候选发现、按 URI 修订、默认审批命令缺席和提案去重通过；第二个宿主进程恢复同一会话，核对同一提案 ID 后通过停用、恢复启用和卸载，安装目录随卸载移除。本次包测试使用合成会话事件；真实 MCP 和模型的行为证据见 M1、M3 和 P0。
- 复现使用 `DSH_NODE_EXECUTABLE` 指向安装的 DSH Desktop Electron 可执行文件，`DSH_INSTALL_DIR` 指向 `app.asar/dsh/node_modules/@deepseek-ai/dsh`，运行 `npm run test:release:dsh`。要保留经过两进程验证的包，可传入已存在的输出目录，例如 `npm run test:release:dsh -- dist`。同名文件存在时退出，避免覆盖固定候选包。
- 下一步由发布者确定公开渠道和许可，并单独授权固定 Git 提交或标签。当前交付为本地已验收候选包。其他 DSH 版本和平台、远端 CI、日用 profile 试用及生产写回均未验收。

## 2026-11-22 · v0.2.0 自治理验收

- DSH Desktop 0.2.2-rc.5 隔离环境已通过自动轮次触发、实际 `ctx.llm.stream` 异步流提炼、提案预览、审批、回滚、模式保存、同会话跨进程去重。使用 `test/dsh-v02-web-integration.mjs`，测试模型为确定性适配器。原生 OpenViking 0.5.5 模式另验证同一条路径，回读核对正文、源元数据、目录和两个附件，并在回滚后逐项与初版比对。
- 原生新建与撤回 `test/create-real.mjs` 通过，核对撤回后的正文与索引。单测覆盖影子模式零读写、设置版本变化拒绝旧运行、自动写入幂等、拒批、版本冲突、未确认写入和 Curator 归档恢复。
- `node test/dashboard-smoke.mjs` 使用实际 DSH 客户端和隔离 Chrome，覆盖登录态、跨来源限制、设置回读、即时复盘、审批和回滚入口、统计、巡检及记忆状态，界面数据由夹具提供。OpenViking Memory 0.5.31 的隔离原生插件实测见 `docs/memory-link.md`。
- v0.2.0 包已在两个 DSH 进程内验收安装、启用、重启、去重、停用和卸载。使用 `npm run test:release:dsh -- dist`。固定产物 `dist/dsh-openviking-skill-evolution-0.2.0.tgz`，38,546 字节，SHA-256 `b5ef3ed1ffab55dda54798ad182a26f81c2c305e009fed33206e2ad8816535ac`。
- v0.2.1 增加多段正文修订，完整核对 hunk 行号、上下文和 YAML 元数据。`npm test` 42/42 通过。两进程装卸实测产物 `dist/dsh-openviking-skill-evolution-0.2.1.tgz`，39,048 字节，SHA-256 `e223b21502b461b49843144c52d0a0b86d66e34af820aaf68b63e34453212b86`。
- 未验证项及依赖见 `docs/hermes-parity.md`。原生 OpenViking 0.5.5 接受过已过时 `If-Match`，共享或多写者自动更新需要服务端 CAS 或统一写入口。长期记忆沿用原生插件。隔离 OpenViking 0.5.5 已验证原生提交、归档和异步提炼。两个新建工作区会话验证偏好命中与 profile 事实回读，一个新建非工作区会话核对偏好原文标记。账号启用 `agent_evolution` 后，用确定性推理夹具完成 case → trajectory → Experience，原生任务 `9b66a0a4-eb0e-461e-8bcc-8fca7e4fdd20` 完成。Experience 精确读取返回 200，两个新建工作区会话均命中该 Experience，归属为用户级 `self`。增加严格断言与索引可见性轮询后，复跑任务 `2e9d39e1-ab59-4c52-bc25-9b3efa97ebad` 退出码为 0。复现见 [原生记忆探针](docs/memory-server-probe.md)。Curator 当前范围为本 DSH profile 的直接读取，跨设备治理需要统一的 OpenViking 停用语义。


## 2026-11-23 · v0.2.2 默认复盘与存量技能

- 全新安装默认 `auto`。复用已挂载的 OpenViking Memory 连接，写入范围限当前用户私有技能。连接信息不可用时有效模式是 `shadow`。保留显式保存过的模式以及显式目标列表。
- 已有技能完整读取后可参与复盘与本 profile 的巡检。写回校验正文、附件及元数据，在上传后再次比较，应用后回读并保留回滚版本。OpenViking 0.5.5 的最后一次比较与写入之间仍有并发窗口。
- `npm test` 43/43，`git diff --check` 通过。DSH Desktop 0.2.2-rc.5 隔离 Web 与原生 OpenViking 0.5.5 实测默认模式更新预置私有技能，核对正文与两个附件、整包回滚和重启去重。夹具提供已解析的 OpenViking 连接配置和确定性模型。生产账号、网关附加认证和共享技能写入未验收。
- 插件管理器安装、启用、重启、停用、重新启用和移除通过。包 SHA-256 `5bdbefde4acbe1455938148102112f103a2d9d4ab27223a58f5409be359e5615`。


## v0.2.3 · 前台学习与附件联合写回

- 参考 Hermes Agent v0.23.3 的 `skill_manage` 和先读后写机制。DSH 前台工具提供 `inspect`、`create`、`patch`，后台模型可提交相同的正文及附件操作，两条路径复用治理、预览和整包版本记录。
- 52 项单测通过。隔离 DSH Desktop 0.2.2-rc.5 实测两条路径，覆盖前台真实工具调度、后台确定性模型推理、预览、应用、整包回滚和重启。两条路径均连接原生 OpenViking 0.5.5 复验，回读正文和附件并与预期逐项比对。
- 原生附件探针 `test/attachments-real.mjs` 验证了带附件的新建、嵌套 UTF-8 CRLF 写入、删除原二进制附件及两次整包回滚。OpenViking 在删除最后一个文件时修剪空祖先目录，回滚恢复原有文件与目录。
- 本地安装包 44,243 字节，SHA-256 `a0dd83240aab17779ca38ca8ec3513ce2aba5cf5f47935470ab55ba95231dd02`，通过两个隔离进程的安装、启用、重启、停用、重新启用及卸载。
- 附件写入支持 UTF-8 文本，本轮测试使用确定性模型与隔离账号。真实模型主动调用频率与生产账号写回待实测，OpenViking 跨客户端条件写入仍为单独议题。

## v0.2.4 · 设置简化

- 将更新方式和连接提示放在设置顶部，高级字段默认折叠，复盘间隔以分钟编辑并转换回毫秒保存。治理下次检查显示本地时间，审计详情可展开。
- 新安装维持自动更新。原生连接沿用现有 OpenViking Memory 的运行时配置，已核对本机插件的 Bearer 与受信身份请求头实现。无可用连接配置时显示实际只保存草稿，保留用户已选模式。
- 52 项单测、隔离 DSH Web 浏览器折叠与保存回读、两进程安装重启与卸载通过。没有使用日用账号做写回验证。
- 安装包 45,572 字节，SHA-256 `aba7b7e5d5a56601a15f505a9d13c57c2c52691668cf56c2903dfce10f41bbee`。

## v0.2.4 · GitHub 首次公开发布

- 公共仓库 https://github.com/ZSQBFan/dsh-openviking-skill-evolution，MIT 许可，源码提交 `1fc2cb384dd40bb3da13a0b78daf7c814a14c6f1`。公开快照包含源码、测试和文档，内部开发提示、笔记、OpenViking 项目配置留在本地。
- https://github.com/ZSQBFan/dsh-openviking-skill-evolution/releases/tag/v0.2.4 附安装包和 SHA256SUMS。公开包加入 MIT 许可证和公开 README 后重打包，SHA-256 `8d01697ce44c112f43bf8f06e7ebdd63e6107ff7230443173f0ab7fd1c04073e`。下载回验、52 项单测、隔离双进程装卸和远端 CI 通过。
