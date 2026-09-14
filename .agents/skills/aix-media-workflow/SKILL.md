---
name: aix-media-workflow
description: 在已登录的 AIX 平台创建或选择画布，把本地 PNG 和创作要求制作成 PRO 图片、Seedance 视频并原生下载，可继续导入 DaVinci Resolve 新工程剪辑和导出；使用本项目 CLI，支持防重复恢复、独立配音与可编辑字幕。
metadata:
  version: "0.5.0"
---

先解析本 SKILL.md 的真实路径，从其所在目录向上三级即仓库根目录。在该目录使用 CLI；输入约束见 [references/configuration.md](references/configuration.md)，首次安装见仓库 README。

用户要求制作时，整理唯一 jobId、参考 PNG、静态图片提示词和视频镜头提示词。保留明确的时长与规格；仅讨论能力或预览方案时使用 plan。用户已授权的正常阶段连续执行。

## 连接与画布

需要 Node.js >=22.12.0；先运行 `npm run doctor -- --live`，分别读取 sourceVersion 和 bridge.version，不把旧进程作为当前源码的现场验收。首次环境需要 `npm run setup`，再在独立终端运行 `npm run bridge`。桥已运行时复用，不启动另一个进程或抢占 socket。真实登录或 Chrome 授权阻塞时说明用户必须完成的那个动作，不复制登录凭据或重配已有 Chrome。

- 当前画布绑定：`node bridge/project.mjs bind --key demo`。
- 用户要求新建时：`node bridge/project.mjs create --key demo --name "AIX Demo"`。
- 按唯一名称选择：`node bridge/project.mjs select --key demo --name "My Canvas"`。
- 已绑定画布重开：`node bridge/project.mjs open --key demo`。
- 多个 AIX 标签页时先用 `project.mjs pages`，再向画布命令传入对应 `--page NUMBER`。

创建会先保存本地尝试记录。同一 key/name 重复执行只返回既有绑定或核对原尝试；结果未知时不得换 key 绕过防重复。切换前原画布必须已保存且没有进行中的任务。不要把自动新建画布当作处理绑定失败的通用修复。

## 制作与恢复

从 `examples/media-job.template.json` 复制配置到 `configs/`，schemaVersion 2 的 `project.key` 指向已绑定画布。先核对 PNG 文件存在，再执行：

```sh
node bridge/media-run.mjs plan --job configs/MY-MEDIA-001.json
node bridge/media-run.mjs run --job configs/MY-MEDIA-001.json
```

plan 必须返回 `validated-plan`。不删除不支持的字段，不偷偷换模型或规格来通过校验。日常生成使用统一 CLI，不绕回临时 eval、直接接口重放或手动补点生成。长等待时根据 JSONL 简短报告阶段。

出错、超时、code 300、漏卡或断连不证明没有执行。检查同一配置的 `status`、`jobs/<jobId>/ledger.json` 与 `last-error.json`，然后 `resume` 同一任务：

```sh
node bridge/media-run.mjs status --job configs/MY-MEDIA-001.json
node bridge/media-run.mjs resume --job configs/MY-MEDIA-001.json
```

遇到 `blocked-submitted-parameters` 保留阻止原因与原请求证据，仅继续只读对账；不能因旧阶段名称为成功而放行。图片卡纠正后须有当前模型、工作流、引用、数量、提示词和原任务归属证据，证据不足不确认生成。原 Agent 响应不得改写。具体的 code 300 历史对账、原生组件适配及 HTTP 状态类型修复见 [references/recovery.md](references/recovery.md)。

status 为本地只读快照，不需要连接桥、不绑定浏览器、不改账本/结果/清单。它的诊断可能早于并发任务的新进展；不要把 status 当作完成验收。run/resume 的修改与结果失效处理由任务所有权及写入锁保护，锁冲突不删锁、不重提生成。

不清账本、不修改已开始任务的配置或参考图、不换 jobId 排错，不重复确认生成或额外下载。无法对账时保留未知状态，报告阶段、已提交次数和恢复命令。

成功后读取 result.json 和输出 manifest，核对参考→图片→视频映射、真实参数、哈希与完整解码。分别报告容器、视频轨和浏览器时长；链路完成与严格整秒符合是两项结论，不自动裁剪、转码或重生。需要画面质量判断时进行本地抽帧或播放审阅，明确检查范围。

当前范围：macOS、Chrome、AIX 简体中文界面；一个 PNG、单张 PRO、Seedance2.0（真人）4 或 5 秒／16:9／720p、一次原生视频下载。摄影灯光为模板固定组合。其他模型、批量、多参考、团队画布管理和服务端取消恢复不支持或未验证。不能要求画布含特定旧素材或固定节点总数。

## 可选：独立配音、字幕与有声成片

用户需要有声视频时，读取 [references/narrated-production.md](references/narrated-production.md)，按其要求分别准备叙事画面、独立配音与真实 Resolve 时间线。先依据旁白实际长度安排节奏，保留可编辑音轨和文字；调整音频或剪辑不触发 AIX 再生成。

当前有声适配器是 30 秒、1280×720、24fps 的已验证配置，不代表所有有声视频都必须采用六段讲解或同一种版式。先明确用户希望观看的内容与风格，再选择合适画面。流程跑通、文件验收和审美满意分别记录，不能把测试样片自动升级为公开宣传案例。

## 可选：进入达芬奇剪辑

用户要求继续剪辑时，复用已完成的 AIX result.json；不得为了剪辑重新生成素材。阅读仓库 `docs/DAVINCI.md`，使用 `examples/resolve-job.template.json` 创建独立剪辑配置，然后执行 `npm run edit -- doctor`、`plan`、`build`、`run`。原图片进入媒体箱，原视频各取前 120 帧进入 24 fps 时间线。用户已授权的剪辑、保存和本地导出连续执行。

画面遮罩需要按实际视频测量并在初次执行前写入 privacy；不能复用其他镜头坐标或将节点存在视为遮罩已进入成片。检查最终 MP4 的像素报告、联系表和原尺寸关键帧，再单独记录人工审阅范围。状态未知只使用原任务 status/resume，不清账本或重新建工程。原始素材、DRP 和本地清单不进入公开案例；选择最终已检查的成片及其预览帧。

发布使用 `npm run release` 的明确文件清单；不上传 `.aix/`、jobs、outputs、configs、inputs、截图、账号绑定或原开发仓库 Git 历史。已审阅的案例片和预览仅从 examples 中按 release-media.json 固定哈希进入包内，字节变化必须重新审阅。当前验收范围见 `docs/VALIDATION.md`，不把局部测试写成新环境全流程通过。
