# 原任务恢复与证据

普通恢复始终使用原配置的 `status` 和 `resume`。status 是本地只读诊断；所有修改由任务锁保护。不能删除账本、修改历史请求、换 jobId 排错或重复不明提交。

## Agent code 300 与历史卡

code 300 不证明任务未执行。resume 可以通过原生历史按钮查询绑定会话，另存历史网络证据；只有会话身份、原始用户请求、手动确认模式、唯一卡片标签、原参考图和单张数量全匹配，才建立单独的 historyRecovery 证明。原响应的 code 300、请求正文和尝试次数保持不变，历史文件和原响应分别固定哈希。没有找到原卡时停止，不能重发准备请求。

历史卡只是原任务来源证据。确认生成前还必须读取纠正后的实际卡片，检查模型/工作流、引用资产、数量、提示词、比例与分辨率；不能凭原 Agent 的模型或显示的 PRO 标签放行。

## 原生组件变化

当前页面可能没有 DOM 的 `__vueParentComponent`。适配器从已挂载的 vnode 树定位对应真实卡片的 ChatPanel，仅读取已识别的 active-card getter。生产构建的 Vue 包装 getter 还须匹配严格的依赖字段序列；不会调用 watcher callback、scheduler 或生成处理器。未知封装继续停止。

Markdown 用户消息中的换行读取 `innerText`，避免 `textContent` 丢失 `<br>` 后误判任务身份；原请求依然逐字核对。确认前再次读取整张实际卡片，状态变化时拒绝点击。

## HTTP 状态表示兼容

MCP 的 HTTP 状态可能是数字 200 或字符串 "200"，二者均是受理状态；业务响应 code 仍须为数字 200。首次真实验证发现旧校验把字符串状态误报为 `ACCEPTED_RESPONSE_EVIDENCE_MISSING`，尽管完整请求的所有参数检查都通过。

仅当账本明确被这一项历史类型误判独占阻止时，使用：

```sh
node bridge/media-run.mjs reconcile-http --job configs/MY-MEDIA-001.json
node bridge/media-run.mjs resume --job configs/MY-MEDIA-001.json
```

此命令在任务锁内保留旧账本原字节，重新读取固定哈希的完整请求/响应并检查所有参数；仅接受真实 HTTP 200 类型差异。错误参数、false ack、缺失正文、证据变化或混合阻止原因仍被拒绝。它不重新生成，也不修改原网络记录。

实际输出的 5.054 秒容器或 5.042 秒视频轨属于平台原生时长偏差，与错误提交参数分开报告。需要严格 30 秒成片时在 Resolve 时间线上按帧剪辑，保留原文件。
