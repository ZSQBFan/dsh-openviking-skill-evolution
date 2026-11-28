<p align="center"><img src="icon.svg" width="96" height="96" alt="技能演进插件图标"></p>
<h1 align="center">DSH OpenViking Skill Evolution</h1>
<p align="center">
  <a href="https://github.com/ZSQBFan/dsh-openviking-skill-evolution/actions/workflows/ci.yml"><img src="https://github.com/ZSQBFan/dsh-openviking-skill-evolution/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/ZSQBFan/dsh-openviking-skill-evolution/releases/latest"><img src="https://img.shields.io/github/v/release/ZSQBFan/dsh-openviking-skill-evolution" alt="GitHub Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3da76a" alt="MIT"></a>
</p>

一个 DeepSeek Harness（DSH）插件，在 OpenViking 的技能存储和记忆能力之上，加入一套类 Hermes 的技能自动维护机制。它会从会话中识别可复用的做法、生成技能改进提案，并按设定自动更新、等待确认或保存草稿，让技能随着实际使用持续演进。

## 功能

- **类 Hermes 的自动技能维护。** 在 OpenViking 技能库之上，按会话中的纠正、成功步骤和失败信号自动复盘，提炼经验并维护已有技能。
- **任务中主动学习。** Agent 可以在任务完成后主动保存新经验或修订技能，后台自动复盘和前台主动学习使用同一套提案、校验和回滚流程。
- **可控的自动更新。** 自动更新、确认后更新、只保存草稿或关闭。可预览正文和文本附件变更，并恢复之前的技能版本。
- **查看技能使用情况。** 在面板里查看复盘记录、技能读取统计，以及 OpenViking 记忆联动状态。也可在当前 DSH 配置中归档或恢复技能。

## 安装

1. 在 DSH 中启用 OpenViking 记忆插件并连接账号。技能演进会沿用这个连接。
2. 从 [GitHub Releases](https://github.com/ZSQBFan/dsh-openviking-skill-evolution/releases/latest) 下载 `.tgz` 安装包。
3. 在 DSH「插件 → 添加插件」中填入下载文件的绝对路径，安装并启用。按宿主提示重载或重启。
4. 打开「设置 → 技能演进」，查看 OpenViking 连接和更新方式。

已在 macOS 的 DSH Desktop `0.2.2-rc.5`、OpenViking `0.5.5` 环境验证。其他平台和宿主版本尚待验证。

## 使用和设置

默认自动维护符合条件的私有技能。连接配置暂不可用时，改进会保存在本机。升级会保留之前明确保存的更新方式。这个流程参考 Hermes 的技能自增长体验，并针对 DSH 会话事件和 OpenViking 技能接口实现。

例如，排查构建失败后，可以对 Agent 说“把刚才验证通过的检查步骤记录成技能，下次发布前按这个顺序检查”。也可用 `/skill-review` 立即复盘当前会话。提案、差异和回滚入口都在「技能演进」面板。

「高级设置」可调整自动复盘的触发条件、间隔、超时和模型。轮次、工具调用和错误次数按来源会话统计。时长触发阈值默认 30 分钟，自动复盘最短间隔默认 15 分钟，单次模型复盘超时默认 300 秒。提供商 ID 和模型 ID 都填写时使用指定模型，任一项留空时沿用来源会话的模型。

待处理提案和运行历史默认各显示最近三条，其余可展开。本地草稿会显示保存原因。你可以批准单条提案或点击「一键批准所有提案」，逐条应用当时符合条件的待审批提案和草稿。处理中的提案自动收起，批量进度实时更新。写入后若暂时读不到确认结果，插件会在后台最多再核验四次。也可点击「核验写入」处理单条记录，或点击「一键核验写入」处理全部待核验记录。核验只重新读取远端版本。

两份列表可以分别确认清空。已应用的技能版本仍可在「已保存版本与恢复」中回滚，复盘去重和重试所需的记录保留在本机。

「技能治理」下的已纳管技能默认折叠。展开后可归档或恢复技能，确认、进度和结果会显示在对应技能旁。收起列表后仍能看到该次操作的进度和结果。

「技能使用情况」显示加载次数和最近使用时间。面板时间使用系统时区。「记忆」分别显示 OpenViking 连接和当前会话的关联状态。会话已关联时，也可查看检索和写入状态。

## 数据与使用范围

- 技能正文和附件保存在 OpenViking，提案和回滚记录由当前 DSH 配置保存。共享技能的改进会留作本地提案。
- 模型复盘会将用于提炼经验的会话片段发送给所选模型。若只想查看建议，可以选择「只保存草稿」。
- 后台复盘响应的事件类型、耗时、字节数和错误阶段保存在 profile 的 `skill-evolution/review-stream/` 目录。日志只保留最近 7 天和最多 256 个文件，不记录模型响应正文或推理文本。
- OpenViking 0.5.5 的技能接口没有原子条件写入。多端共用技能库时，可先将更新方式设为「只保存草稿」。
- 面板里的归档作用于当前 DSH 配置，技能正文仍保留在 OpenViking。

## 开发与反馈

使用 Node.js 22 或以上版本运行 `npm test` 和 `npm run test:release`。发版前，同一候选包还需通过隔离 DSH Web 的审批门禁，见 [发布验证](https://github.com/ZSQBFan/dsh-openviking-skill-evolution/blob/main/docs/release-verification.md)。反馈时请附上 DSH 版本、系统和复现步骤，并先移除日志中的私人信息。详见 [Issues](https://github.com/ZSQBFan/dsh-openviking-skill-evolution/issues) 和 [更新日志](CHANGELOG.md)。

[MIT](LICENSE) · zsqbfan
