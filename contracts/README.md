# 跨项目契约

`protocol.json` 与 PM Skill 的固定副本逐字节对应。本次拆分的格式定义源于 PM Skill；变更时同时校验两个候选的兼容性，不在运行时读取相邻项目。

`task-log.md` 是应用展示已登记日志时使用的公开格式文档快照。

`reader-snapshots.json` 记录拆分前来源 commit、原始文件哈希及当前应用读取器哈希。读取器已成为本应用自有源码；`originHashes` 仅追踪来源，不表示修改后仍应与 Skill 全部相同。格式升级需要行为夹具验证，不只比较代码文本。
