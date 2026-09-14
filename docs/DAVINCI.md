> Follow-up development: [voiced schema 2](NARRATED-VIDEO.md) adds narration and editable text. The schema 1 silent workflow below remains compatible. Sealed 0.4.2 files are unchanged.

# AIX 素材进入 DaVinci Resolve（0.4.0）

这条本地链路读取已完成的 AIX 任务清单，核验原文件哈希，在新的 Resolve 工程导入图片和视频，把每条视频的前 120 帧按顺序拼接，并用 Resolve 原生 H.264 导出。原始 AIX 文件保留；整秒裁剪只发生在剪辑时间线上。

已实测环境：macOS 14.6.1、DaVinci Resolve Studio 19.0.0.69、Python 3、Apple Swift 6。使用随 Resolve 安装的官方 Python Scripting API；没有额外云服务。其他版本和免费版没有验证。

## 使用

先打开 Resolve，确保其本地脚本接口可用，然后在仓库目录执行：

```sh
npm run setup
npm run edit -- doctor
cp examples/resolve-job.template.json configs/MY-EDIT-001.json
```

修改配置中的项目名、唯一 jobId 和 AIX result.json 路径。完成所有输入任务后：

```sh
npm run edit -- plan --job configs/MY-EDIT-001.json
npm run edit -- build --job configs/MY-EDIT-001.json
npm run edit -- run --job configs/MY-EDIT-001.json
```

`plan` 只校验。`build` 新建工程、导入素材并建立时间线，停在原生导出之前，便于检查画面。`run` 连续完成这些步骤和导出。可选的 `init` 允许输入任务尚未完成时提前建立同一个空工程；它不会生成 AIX 素材。

```sh
npm run edit -- status --job configs/MY-EDIT-001.json
npm run edit -- resume --job configs/MY-EDIT-001.json
```

状态保存在 `.aix/resolve/`。同一任务绑定同一工程和时间线；完成后重复执行核验已有结果，不重新导入或渲染。配置或素材哈希改变会拒绝恢复。渲染结果未知时检查原队列，不删除账本或改 jobId 重试。工具会保存当前工程再切换，拒绝接管同名的非绑定工程。

## 已支持的剪辑范围

- 1–6 个已完成 AIX 清单；实际完整验收为 3 个镜头。
- 每个清单恰好一张 JPG/PNG 和一条可完整解码、至少 5 秒的 MP4。
- 图片和视频共用 `AIX Sources` 媒体箱；当前时间线只剪视频，图片保留供后续编辑。
- 1280 × 720、24 fps；每镜头前 120 帧，顺切；无音轨、配乐或字幕。
- 原生 `.drp` 工程备份和 MP4。`.drp` 不包含完整媒体，换电脑需携带输出目录中的 `media/` 并重新链接。
- 未提供自动重新剪辑已完成工程、多轨混音、字幕、转场或自动隐私识别。

## 隐私遮罩与检查

`privacy` 是按 case key 配置的视频不透明黑色矩形。每个关键点是 `[秒, 中心X, 中心Y, 宽, 高, 角度]`，坐标和尺寸归一化为 0–1，Y 原点在画面底部。必须从第 0 秒开始，最多 20 个点，点间线性插值。几何位置需要根据实际视频测量；示例为空，不代表任何内容已脱敏。

```json
{"example": {"video": [[0, 0.8, 0.9, 0.1, 0.04, 0], [5, 0.82, 0.9, 0.1, 0.04, 0]]}}
```

Fusion 修改通过原生撤销事务提交，逐镜头激活并保存。导出前验证遮罩颜色、几何表达式和连接；导出后完整解码，并检测每个遮罩核心区域的像素。核心检查能发现遮罩未进入成片，但不能判断遮罩是否覆盖了所有私人信息。

`qa/pixel-review/` 含每镜头 9 个时间点的联系表和像素报告。必须审阅实际成片，包括镜头切点、首尾、屏幕内容和遮罩边缘。检查结果中的 `visualReviewRequired` 不会因为自动解码成功而自动消失。也可抽取指定秒数的原尺寸帧：

```sh
bridge/probe-video-frames outputs/MY-EDIT-001/aix-story.mp4 outputs/MY-EDIT-001/qa/frames 0,2,4.958333333333333,5,7,9.958333333333334
```

Resolve 工程、原始图片、原始视频、配置、清单、失败导出和质检截图均按私人工作数据保留。对外案例只选择经过画面检查的成片和从该成片提取的预览帧，再检查元数据。原始图片未经过视频遮罩；不要直接拿原图替换已检查的预览帧。

## 本次案例验收

“男生操作 AIX”案例在一个新工程里导入 3 张图片、3 条视频，形成 15 秒时间线。原有敲键盘镜头后新增“生成山海画面”和“查看成果”两条各请求 5 秒的素材。新任务各只执行一次图片生成、一次视频生成和一次原生下载。

第一条新增任务遇到上传回执超时；恢复时根据已准备节点和文件哈希识别原上传，没有再次上传。开发中第一份完整剪辑未提交第二镜头的 Fusion 改动，实际画面检查将其拒绝；修复原生事务后在同一工程重导，旧文件与原渲染记录保存在本地。负向检查在旧文件发现 120 个未通过的遮罩帧；最终文件的 240 个遮罩帧全部通过。另有两个 5 秒本地渲染探针，不属于 AIX 新生成任务。

最终成片：360 帧全部解码、15.000 秒、1280 × 720、24 fps、无音轨。每镜头 9 个时间点的联系表及关键帧已审阅；同一工程关闭、重新加载后，素材哈希、时间线位置和 Fusion 连接仍一致。最终重复执行返回零新工程、零新导入、零新渲染。此结果是同一台机器的实测，不是另一台机器或新账号的验收。
