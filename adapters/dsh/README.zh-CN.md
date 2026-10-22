# DSH 运行观察器

只订阅 Cordis 的 `agent/created`、`agent/status`、`agent/disposed`，不提供模型工具、命令、预设或业务状态写入。所有写入复用 PM Server 的运行观察核心。

在实际 DSH 配置中添加 host-plane 插件，文件位置使用 `pm-server adapter check dsh` 返回的本机路径。示意：

```yaml
plugins:
  pm-server-observer:
    name: '/absolute/installed/pm-server/adapters/dsh/observer.js'
    instance: main
```

配置结构与重载方式须按当前 DSH 验证，示意不证明宿主已加载。实例 ID 在重启后保持稳定；换路径后必须确认真实模块重载，不凭标记认定新代码生效。npm 升级后重新核验配置引用。

默认写应用状态目录，使用 `dsh:main:<编码后的原生ID>`。显式 `runtimeCsv` 仅作旧单宿主原生 ID 桥接，不用于多平台共享路由。

失败只告警，不影响宿主。加载标记按实例记录，不能替代真实事件验收。该包在新路径下的真实 DSH 集成仍待核验。
