# M2 OpenViking 技能接口实测

OpenViking 0.5.5 的私有技能可以通过 ZIP 整包替换和恢复。本次实测中，附件内容、嵌套 frontmatter 元数据和显式传回的来源元数据均保留，技能检索随更新和恢复返回对应描述。陈旧的 `If-Match` 仍成功覆盖，客户端超时也曾先于服务端写入完成。M2 的写入模式应保持受控单写，写前回读仅能发现已经发生的变化。

## 环境与复现

实测使用 macOS arm64、CPython 3.12.12 和 PyPI `openviking==0.5.5` 原生 wheel `openviking-0.5.5-cp310-abi3-macosx_14_0_arm64.whl`。`/health` 返回 `healthy: true`、`version: 0.5.5`、`auth_mode: api_key`。Python 探针启动独立回环 HTTP 服务和临时 HOME、数据目录、缓存与账户。OpenViking 的路由、Rust RAGFS、存储、索引、权限与审计均来自 wheel。推理端使用回环 OpenAI 兼容服务，提供确定性摘要和 8 维向量，因此索引验证只覆盖写入后的可检索性与返回字段，不测语义排序质量。部署端写入、配置和版本兼容性尚未验证。

```sh
OV_PROBE_DIR=$(mktemp -d /tmp/ov-m2-probe.XXXXXX)
UV_CACHE_DIR="$OV_PROBE_DIR/cache" uv venv --python 3.12 "$OV_PROBE_DIR/venv"
UV_CACHE_DIR="$OV_PROBE_DIR/cache" uv pip install --only-binary :all: \
  --python "$OV_PROBE_DIR/venv/bin/python" 'openviking==0.5.5'
"$OV_PROBE_DIR/venv/bin/python" -B test/ov-m2-probe.py \
  --server-bin "$OV_PROBE_DIR/venv/bin/openviking-server"
```

探针逐步输出 JSON 证据并检查断言。独立运行退出码为 0。可选 `--approval-probe <Node 脚本>` 在同一实例上使用恢复后的私有测试技能，临时环境中传递连接参数和账本目录。详细请求和断言见 [ov-m2-probe.py](<../test/ov-m2-probe.py>)。公开参考见 [OpenViking Skills API](https://docs.openviking.ai/en/api/04-skills) 和 [OpenViking 0.5.5 PyPI](https://pypi.org/project/openviking/0.5.5/)。

## 观察结果

| 操作 | 实测结果 |
| --- | --- |
| 读取快照 | `GET /api/v1/skills/{name}` 查询 `target_uri=<skills root>&level=2&include_files=true&include_integrity=true&include_source=true`。返回 `result.root_uri`、`skill_md_uri`、`content`、`content_sha256`、`files`、`revision`、`source`。两种响应头 `ETag` 和 `Last-Modified` 均未出现。 |
| 附件导出 | 读取 `files[]` 的 `path`、`uri`、`is_dir`、`size`、`sha256`。`GET /api/v1/content/download?uri=...` 凭当前用户 API key 返回原字节。两个嵌套附件及 SKILL.md 的下载摘要与 manifest 逐项一致。生成的 `.abstract.md` / `.overview.md` 在根和子目录均出现，后者甚至标为 `kind: auxiliary`。按保留文件名过滤，恢复时由服务重新生成。 |
| 整包写回 | `POST /api/v1/resources/temp_upload` 以 multipart 字段 `file` 上传包含 `SKILL.md` 与全部附件的 ZIP，取 `result.temp_file_id`。`PUT /api/v1/skills/{name}` 发送 `target_uri`（根）、`temp_file_id`、`source_metadata`、`wait: true`。返回 `result.action: update`，语义和嵌入队列 `error_count: 0`。`PUT` 缺少已安装目标返回 `404 NOT_FOUND`。 |
| 内容与来源 | 安装会规范化 `SKILL.md`，例如 `allowed-tools: [Read]` 变为 `allowed-tools: Read`，列表、空行与末尾换行也发生变化。用存储端回读内容做审批基线。ZIP 更新传回原 `source` 对象保留了标记和来源。内联 `data` 更新移除了两份附件，并把来源替换为 `inline_content`。`source` 与 frontmatter 的 `metadata` 应分别跟踪。 |
| 权限 | 常规用户 Alice 更新自身私有技能成功。Bob 显式访问 Alice 私有根返回 `400 INVALID_ARGUMENT`。相同账户的普通用户 Alice 可以更新本夹具默认权限下的共享技能。使用明确的私有根更新时，同名共享技能的完整修订摘要不变。插件应自行检查目标属于当前用户且已明确纳管。 |
| 条件更新 | 过期 `If-Match` 返回 HTTP 200 并替换内容。请求体额外 `expected_revision` 返回 `400 INVALID_ARGUMENT`，消息为 `body.expected_revision: Extra inputs are not permitted`。OpenAPI 模型 `additionalProperties: false`。安装版 `openviking/server/routers/skills.py` 的 `prepare_replacement` 持有树锁，复查存在性后清除整包。该锁没有检查调用方的期望版本。 |
| 索引 | `POST /api/v1/skills/find` 发送 `query: <name>`、`target_uri: <skills root>`、`limit: 20`、`score_threshold: 0`。`result.skills[]` 的 `root_uri` / `skill_md_uri` 匹配目标，描述按原版、更新、恢复依次变化。顶层命中 `uri` 可以是 `.abstract.md`，应按 canonical 字段匹配。 |
| 客户端超时 | 让本地推理延迟，`wait: true` 的 PUT 在客户端 0.7 秒超时。随后多次回读先出现旧修订，再出现一次无修订的响应，最后观察到目标修订。恢复回读再次核对附件原字节、来源与索引。复用该上传 ID 再提交一次实测 HTTP 200 并返回另一个 `task_id`，所以单靠上传 ID 或超时不足以判断请求是否已应用。 |
| 审计 | 本地默认配置下 `GET /api/v1/console/audit` 以普通用户凭据返回 200。实测 PUT 条目带 `request_id`、`account_id: probe`、`user_id: alice`、路由模板、状态码、耗时和时间，未返回审批 ID、目标修订、文件版本或回滚包。调用方账本需要独立绑定提案、审批、基线、目标、写入结果与恢复快照。 |

## 内容完整性证据

| 状态 | `SKILL.md` SHA-256 | 服务端 `revision` |
| --- | --- | --- |
| 原版 | `dac5696f5f03b1017f6750c3751a77d1646bb681b4d3e1a491ab90d954f0936d` | `8e91d456e77b6387ddd16f7c32a30288115ce5bd7258d83886c2d8b655bc84d6` |
| ZIP 更新 | `23e24f258f8c7f2e944332671ed1f28085491ed6d881eece34bc6acc86d83272` | `cf3483545fb1157405b0e235ea819bb24546b55075083605d934703a78653659` |
| 陈旧条件下的内联覆盖 | `dac5696f5f03b1017f6750c3751a77d1646bb681b4d3e1a491ab90d954f0936d` | `3ee570c564923a7dc7425ef83be347856ebe00aac670557fd9c0c42d012a0309` |
| ZIP 恢复 | `dac5696f5f03b1017f6750c3751a77d1646bb681b4d3e1a491ab90d954f0936d` | `8e91d456e77b6387ddd16f7c32a30288115ce5bd7258d83886c2d8b655bc84d6` |

`assets/blob.bin` 为 `c86c680260d851cf75791cdb39a77fdf0246dbe4a1b5bf4300fcb5ce8c6b4140`。`refs/steps.txt` 为 `b6a98d9ce9a2d9149288fa3df42d377c3e42737afdcdaf714e33c0a100b51060`。原版、ZIP 更新和 ZIP 恢复三者一致。恢复包由原版 HTTP 下载得到的定义和附件字节构造。夹具启用了确定性推理，服务端 `revision` 包含生成的总结文件，实际模型可能重新生成不同摘要。内容恢复检查应独立比较正文、附件和可恢复元数据。`source` 另行读取，本次由调用方显式传回。

安装版 PUT 路由还调用 `apply_skill_privacy(..., delete_if_empty=True)`。本次复现使用无隐私字段的技能，隐私配置及其版本、ACL、标签服务设置和历史审计的数据完整性仍待独立验证。普通技能包快照没有覆盖这些独立状态。
