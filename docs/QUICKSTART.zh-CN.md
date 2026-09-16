> 0.6.0 新增参考视频白模拆解、画布整理及后期音效验收指南；见 [三个技能入口](../README.md)。公开生成 CLI 仍使用 schema 2。

> 0.5.0 新增 [独立配音、字幕和达芬奇有声时间线](NARRATED-VIDEO.md)。原有无声任务继续兼容；封存的 0.4.2 不改动。

# 从 AIX 生成素材到达芬奇导出

本包包含源码、项目 Skill、参数模板，以及已脱敏的 15 秒“男生操作 AIX”案例。无需账号即可查看 `examples/aix-story/README.md` 和成片。重新生成会使用你自己的 AIX 登录状态与额度；安装和测试不会调用生成。

0.5.0 保留 status 只读和并发账本保护，补充独立 TTS、按词时间戳对齐字幕、真实 Resolve 音轨和 Text+ 文字、有声导出及校验。本机已完成一个新的 AIX 图片→视频→原生下载任务，也验证了 30 秒有声工程；过程中修复了历史卡读取、原生组件和 HTTP 状态类型兼容，均保留记录，不宣称首次无介入通过。介绍片作为流程验证样片，其剪辑风格未作为公开宣传案例获认可。

## 1. 安装

当前验收环境是 macOS Apple Silicon、Node.js >=22.12.0、Python 3.9 以上、Apple Swift 编译器、Chrome 简体中文 AIX 界面，以及 DaVinci Resolve Studio 19 的官方本地脚本接口。包内不包含这些应用或其授权。

将 ZIP 解压到独立文件夹，在该文件夹打开终端：

```sh
npm run setup
npm run test:all
npm run doctor
```

Node 22.0 和 22.11 不满足要求，setup、doctor 和桥启动会提前报错；直接安装也启用 npm engine-strict。

setup 从固定 lockfile 安装桥接依赖，并在本机编译解码、抽帧和像素检查程序。首次安装需要联网。AIX 原生视频可能略长于请求时长；后面的达芬奇时间线负责精确裁到每段 5 秒。

## 2. 连接 AIX 画布

用 Chrome 登录自己的 AIX，打开 `https://aix.studio/AixCanvas`。在一个终端启动并保持运行：

```sh
npm run bridge
```

在第二个终端检查连接并创建画布：

```sh
npm run doctor -- --live
npm run project -- create --key demo --name "AIX Story Demo"
```

若希望使用当前打开的画布，将上面的 create 换为 `npm run project -- bind --key demo`。Chrome 要求远程调试授权时，在 Chrome 完成授权。已有桥进程和任务时继续使用原目录，不再启动另一个桥抢占连接。

## 3. 准备三个镜头

附带三份故事模板：敲键盘、点击生成、查看成果。它们以已脱敏的成片首帧作为人物参考，便于保持人物和场景衔接；结果不保证与示例逐像素相同。

```sh
mkdir -p configs
cp examples/story/shot-1.job.json configs/STORY-001.json
cp examples/story/shot-2.job.json configs/STORY-002.json
cp examples/story/shot-3.job.json configs/STORY-003.json
```

先修改配置中的提示词、参考 PNG、画布 key 和输出目录。更换任务 ID 时同时修改文件中的 `jobId`；不要重用已经执行过的 ID。相对路径按复制后的 configs 目录解析。

逐条校验并制作；前一条完成后再进入下一条：

```sh
npm run media -- plan --job configs/STORY-001.json
npm run media -- run --job configs/STORY-001.json
npm run media -- plan --job configs/STORY-002.json
npm run media -- run --job configs/STORY-002.json
npm run media -- plan --job configs/STORY-003.json
npm run media -- run --job configs/STORY-003.json
```

每条任务由一张 PRO 图片和一条请求 5 秒的 Seedance2.0（真人）视频组成。成功清单位于 `jobs/<jobId>/result.json`，原始素材在对应 outputs 目录。超时不代表未执行，使用同一配置的 `status` 和 `resume`；不清账本或修改已开始的配置。

## 4. 导入达芬奇并剪辑

打开 Resolve Studio。先检查接口，再复制剪辑模板：

```sh
npm run edit -- doctor
cp examples/resolve-job.template.json configs/MY-EDIT-001.json
```

模板已引用上述三个 STORY 任务。确认工程名称未被其他工程使用，并在首次运行前配置需要遮盖的画面区域。privacy 默认为空；它不能自动识别私人信息。坐标和限制见 [达芬奇说明](DAVINCI.md)。

```sh
npm run edit -- plan --job configs/MY-EDIT-001.json
npm run edit -- build --job configs/MY-EDIT-001.json
npm run edit -- run --job configs/MY-EDIT-001.json
```

build 导入 3 张图片与 3 条视频，并将视频各取前 120 帧放在一条时间线上。run 用 Resolve 原生编码导出 15 秒、720p、24 fps 的无声 MP4，并保存可继续编辑的工程备份。图片保留在媒体箱，不额外延长时间线。

结果在 `outputs/MY-EDIT-001/`：`aix-story.mp4`、`aix-story-local.drp`、`resolve-result.json`、`media/` 和 `qa/`。DRP 不嵌入所有媒体；迁移电脑需带上 media 目录并重新链接。当前工程和备份包含本机媒体路径。

## 5. 核对成片

完整解码、帧数、时间线、原文件哈希和已配置遮罩核心像素会自动核对。你仍需检查成片和 `qa/pixel-review/` 联系表，尤其是账号区域、遮罩边缘、首尾及切点。只看到 Fusion 节点不代表其效果已正确写入视频。

中断后查询原任务：

```sh
npm run edit -- status --job configs/MY-EDIT-001.json
npm run edit -- resume --job configs/MY-EDIT-001.json
```

已完成任务重复执行只核验已有文件。原任务结果未知时不会自动新增渲染、重建工程或重新生成。

## 6. 打包与分享

对外附件应从最终审阅过的成片提取。原图没有视频遮罩，不应直接替换脱敏预览。发行包使用明确文件清单，真实案例只允许已审阅且哈希固定的文件；`.aix/`、jobs、outputs、configs、inputs、原始媒体、日志和 DRP 均不进入包内。

本项目已发布到 GitHub。使用它制作的素材与工程保留在你的本机；如需发布自己的作品或发行包，按 [发布流程](RELEASING.md) 另行检查和上传。

## 参数错误与恢复

实际提交参数不符或旧账本缺少必要证据，会持久化为 `blocked-submitted-parameters`，阻止继续制作和完成清单。继续使用同一任务的 status 做只读对账；不得改请求证据、清账本或换 ID 重生。已生成资产保留。在持锁的制作或恢复路径发现旧 completed 清单无效时，会保留原字节备份并将当前清单标记为 blocked；status 只给出诊断，不修改文件。请求正确但平台输出为 4.062 秒等时长偏差，仅另行记录严格时长不符，不属于提交参数错误。

## 并发状态查询

status 现在完全读取本地快照，无需桥进程，不绑定或切换浏览器目标，也不改写 ledger、result、manifest 或创建失效备份。运行中的任务可以继续推进。输出 observedPhase 是读取时的账本阶段，state 和 parameterValidation 表示计算出的诊断；快照可能落后于并发任务，不能当作最终完成验收。

run/resume 保留任务所有权；CLI 和 daemon 的每次账本修改及结果失效处理另受独占写入锁保护，并在锁内读取最新状态。锁冲突时报告并使用 status 对账，不删除锁或绕过提交占位。详见 CONCURRENCY.md。
