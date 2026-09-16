---
name: aix-canvas-organizer
description: 按成片来源整理已登录 AIX 画布，将采用素材和直接参考与历史、替代及失败尝试分区；保留素材、参数和连线，备份并验证保存。
metadata:
  version: "0.6.0"
---

用户要求整理画布时使用。不把画布整理变成生成、删除媒体或上传成片；这些操作需要对应的用户任务授权。用户已要求整理时直接完成备份、分区、保存和检查，不重复询问是否允许移动。

## 核对范围

通过 Chrome/AIX 工具查看用户已打开的页面，核对画布名称与身份，不仅凭最后打开的标签页猜测。工具不可用时先发现可用浏览器工具，不能复制登录凭据。若位于 AIX Media Bridge 仓库，先执行 `npm run doctor -- --live`，复用已有桥。

从最终剪辑清单、素材哈希、帧范围和生成引用确认使用关系。将“成片直接使用”“直接参考”“未采用的版本”“历史探索”“失败尝试”分开。保留必要的直接上游参考；不把所有祖先节点都归入成片采用区，也不要仅凭文件名较新就认定被采用。

先读取当前节点、分组、连线、位置和状态。在 `.aix/layouts/任务目录/` 私下保存快照，含资产链接和提示词的快照不得进入发布包。生成中先等待；已有未保存编辑先保存，确认之后再拍快照。遇到组到组/节点的连线时，当前自动布局脚本会停止，改为保留原组边界的人工布局计划。

## 计划与应用

本技能的 `scripts/layout.mjs` 只生成布局脚本和做校验，本身不连接浏览器。必须通过当前可用的 Chrome JavaScript 工具执行输出的函数。工具结果如带 Markdown/文本封装，应只取 JSON 对象保存，不能把整个工具响应当作快照。

1. `node scripts/layout.mjs snapshot-script SNAPSHOT.js` 输出只读函数；在目标 AIX 页面执行，将结果存为 `before.json`。
2. 建立 `classification.json`。每个节点恰好属于一个组；各组包含 `label`、十六进制 `color`、`nodeIds`、`x`、`y`、`columns`。IDs 只能来自快照。采用区与归档区明显分开；组内按镜头或生成链路排序。为长标题和连线留空间。
3. `node scripts/layout.mjs plan before.json classification.json plan.json`。计划绑定画布、原位置、媒体链接、参数和连线摘要；重复、遗漏、重叠会失败。检查分区列表后生成 `node scripts/layout.mjs apply-script before.json plan.json apply.js`。
4. 先在当前前端确认 `updateNodePosition(ids, dx, dy)`、`deleteGroup(id)`、`addGroup(group)` 的语义；`deleteGroup` 必须只移除容器，不删除节点。方法同名不足以证明新版前端仍然兼容。语义不明时用原生 UI，不猜私有函数参数。
5. 在已核对的页面执行 `apply.js` 一次。它只修改位置与分组，保留节点内容和节点间连线。旧分组容器会被新分类替换；快照保留其原始信息。结果未知先只读检查，不能重复补点；若现状完整匹配计划，脚本返回 already-applied。

脚本路径相对本技能目录。完整快照、分类和计划均为本地私有运行数据。不要提交到 Git。

## 保存与验收

检查实际画布截图，确认没有遮挡或跨区混排。通过原生保存入口保存同一个画布，核对名称；在已观察到的 AIX 界面可用 Control+S 打开保存对话框。点击确认保存后检查保存成功和 edited=0。

重新加载或通过原生历史重新打开同一画布，执行快照函数保存 `after-reload.json`，再运行 `node scripts/layout.mjs verify after-reload.json plan.json`。核对节点总数、资产链接、参数、连线端点、分组成员和位置。浮点位置容差与服务端重建连线 ID 是允许的表示差异，不允许真正丢失连线或素材。edited=0 本身不证明保存成功。

失败时保留当前状态和 before.json，不用重新生成来“补齐”缺失素材。最后将视图调到用户能理解分区的位置，报告相关/归档数量、是否保存及实际核验范围。
