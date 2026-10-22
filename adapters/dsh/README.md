# DSH runtime observer

[English](README.md) · [简体中文](README.zh-CN.md)

Subscribes only to Cordis `agent/created`, `agent/status` and `agent/disposed`. It does not register model tools, commands, presets or business-state writers. All observations use PM Server's shared runtime core.

Use the local path returned by `pm-server adapter check dsh` in the actual host-plane configuration. Example only:

```yaml
plugins:
  pm-server-observer:
    name: '/absolute/installed/pm-server/adapters/dsh/observer.js'
    instance: main
```

Confirm the configuration structure and reload behavior for the actual DSH version. This example is not proof that the host loaded the module. Keep instance IDs stable across restarts and verify the configured path after npm upgrades.

The default application directory uses `dsh:main:<encoded-native-id>`. An explicit `runtimeCsv` is a historical single-host native-ID bridge, not a multi-platform route.

Failures are logged without disrupting the host. Per-instance load markers do not prove lifecycle-event delivery. Native DSH loading from the new package path still requires validation.
