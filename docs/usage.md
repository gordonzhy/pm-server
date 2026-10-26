# PM Server usage guide

Shares expose de-identified task progress, priorities and dependencies using per-share aliases. Original names, titles, content, logs, attachments, runtime identities and local paths remain private. The shared CSV and task detail are generated from this restricted model; original files cannot be downloaded by viewers. Notification bodies are generic reminders; inspect details through the authorized local workbench or CLI.

[Product overview](../README.md) · [简体中文](usage.zh-CN.md)

## Awaiting-confirmation follow-up

This is an Unreleased GitHub source feature, absent from the published npm `0.1.0-rc.16` package. Use the reviewed source candidate to try it; installing the existing npm package does not provide it.

The background task monitor separately checks `待确认` tasks in confirmed registered projects, even without active tasks, execution routes or runtime observations. It groups due cards across projects by the current manager in `project-manager.config.json`; old task-row manager routes are not used. No manager produces a diagnostic, not a guessed recipient.

The first reminder is due after one hour (`PROJECT_MANAGER_CONFIRMATION_AFTER`, seconds, minimum 60). Accepted messages repeat after one day (`PROJECT_MANAGER_CONFIRMATION_REPEAT`, minimum 3600). Failed or disabled delivery retries after five minutes (`PROJECT_MANAGER_CONFIRMATION_RETRY`, minimum 60). Each episode allows three fast failed attempts before using the daily repeat interval; accepted delivery resets this budget. Health retains failed/unknown delivery counts during cooldown. Set these environment variables on the monitor process. Missing, invalid or future task timestamps start aging from local first observation. Source row or detail changes and manager changes start a new waiting interval; an observed departure and reentry also starts a new interval. Changes between polls cannot be reconstructed. State is private to the application state directory and survives restart; parallel workers share a delivery lock.

Reminders use a fixed generic message. The manager checks the authorized local workbench or CLI, records who is awaited, the question or evidence, the next action and follow-up time. Backend acceptance does not prove manager handling or host wake-up. This branch never changes task sources, reassigns work, nudges users or resumes paused work. Active-task timed pauses do not mute this separate follow-up; blocked/user-paused tasks are excluded. Removing a project or explicitly stopping the monitor stops its future checks. The service health exposes `confirmationWatch` counts, cooldown, delivery failures and fixed diagnostic codes. An interrupted send is marked `UNKNOWN` and held for the repeat interval before retry; a crash after external acceptance cannot guarantee exactly-once delivery.


## English and Chinese

The login page, workbench, settings, sharing, notifications and task details support **English and Simplified Chinese**. With **System default**, the interface follows the browser's preferred language: Chinese locales select Chinese; other locales use English. Browsers expose their preferred language rather than a separate operating-system language setting.

Use the language selector to override the default. Your choice is remembered on this browser and shared with same-origin task-detail pages. Choose **System default** to follow the browser again. Dates and durations use the selected interface language.

Project names, task titles, descriptions, authors, evidence and file paths remain as written. Translating a status label never changes its CSV value or filter identity.

## Current release

`0.1.0-rc.16` is the published preview package. Use `npm install -g pm-server@0.1.0-rc.16` for a reproducible installation; `next` follows the registry tag. Unreleased GitHub source changes are separate from this published package.

| Capability | Scope |
| --- | --- |
| Multi-project workbench | Authentication, connections, read-only sharing and timelines |
| Monitoring and reminders | Read-only task access; operational state lives in the application directory; delivery requires explicit configuration |
| Standard event input | Common JSON interface for Codex, Claude Code and DSH; identities include platform and instance |
| Codex Hook | Explicit installer with backup; trust and native event delivery must be verified on the target host |
| DSH | Minimal Cordis observer using three lifecycle events; native loading still requires validation |
| Claude Code | Standard event input available; automatic native Hook installation is not implemented |
| Operating systems | macOS checks/CI and Ubuntu container installation, CLI and Chromium checks; other Linux distributions and Windows remain unverified |

A working event input does not prove native platform integration. A session status is evidence about execution, not a task acceptance decision.

## Install and run

Requires Node.js 22 or later. The server uses Node built-ins and does not require Python. PM Skill's project tools require Python 3.10+.

```sh
# Build from source (optional)
npm pack
npm install -g ./pm-server-0.1.0-rc.16.tgz

# Install the preview from npm
npm install -g pm-server@next

pm-server doctor --json
pm-server setup
pm-server status --json
pm-server open
```

Installation only installs files. It does not change host settings, start services or enable login startup. The workbench defaults to `http://127.0.0.1:9999/`; its password is stored in `password.txt` in the application state directory. `status` reports the actual endpoint.

```sh
# Register a valid project automatically; no confirmation step
pm-server project request --repo /absolute/path/to/project
pm-server project list

# Stop both background components and remember the disabled state
pm-server service stop

# Read-only status; ensure only acts on an existing enabled configuration
pm-server service status
pm-server service ensure
```

State is independent of the AI host. On macOS it defaults to `~/Library/Application Support/pm-server`. Set `PM_SERVER_STATE_DIR` or pass `--state-dir` to override it. Tests must use both an isolated state directory and an explicit port, such as `--state-dir /tmp/pm-server-demo --port 10009`.

`service run` runs the workbench and monitor in the foreground. System startup integration, automatic upgrades and migration from older project-manager installations are not included in this release.

## First-time Codex setup

After installation, the primary onboarding entry is `pm-server setup` (available starting with 0.1.0-rc.4). Run it in a terminal to see completed, actionable, unverified and currently unnecessary steps. Exit and rerun to recheck and continue. The workbench provides ongoing visibility and reminders.

```sh
pm-server setup
# Keep these options when continuing with an isolated service:
pm-server setup --state-dir /tmp/pm-server-demo --port 10009
pm-server setup codex --dry-run
pm-server doctor --check-host --json
```

The menu offers hook installation/repair and service startup, explaining user permissions and backups before changes. It can open normal Codex CLI for optional `/hooks` review/trust and a harmless tool operation; use `/quit` to return and recheck. It never grants trust automatically. Project connection and backend selection remain separate operations. The first registered manager triggers an automatic notification check; only failures need attention.

Selecting Codex notifications saves only the backend preference in application state and restarts that directory’s service with its actual port and listen address. Future terminals and background services share it. Explicit notification environment settings take precedence; resolve conflicting settings first. See Configure reminders for custom backends. No target is selected and no test is sent automatically.

Automation must explicitly use `pm-server setup codex --json`: this backs up and merges hooks, starts services and returns JSON with unfinished checks. It does **not** perform the other menu operations. Bare non-terminal `setup` refuses changes and explains the supported commands. npm installation only installs files, with no host-changing postinstall or system startup installation. The state binding is saved beside user hooks, so later Codex shells need not inherit setup’s environment.

Older versions can use `adapter install codex` and `service start` separately. Open `/hooks` in Codex CLI, review and trust the current definitions, then run a real session with a tool call. Installing configuration does not grant trust; PM Server never edits Codex's internal trust store. Recheck changed definitions after upgrades.

`doctor`, `status`, `service start` and `setup` report hook configuration, cached observations, host trust verification and notification configuration separately. A started workbench or a cache row does not establish full readiness. `ACTION_REQUIRED` means setup or verification remains. Configure and test a notification backend and register manager/execution routes before relying on missed-handoff reminders.

## Setup guide and reminders

The workbench works independently of AI host or manager sessions. **Settings → Setup guide** shows basic project-source checks; unreadable sources require attention. Required integration configuration is grouped by selected host, with its own pending count. Codex requires a matching Hook return entry and state binding plus an available notification send backend; completed configuration is shown as configured with runtime verification deferred. Hook loading/events, actual notification delivery/returns and manager alignment stay in folded runtime diagnostics. Login is not checked by onboarding. No manager needs to be online to view tasks. Owner authentication, sharing permissions, CSRF protection and source isolation remain enforced.

Basic checks refresh on initial load, page visibility and each visible minute. **Check again** refreshes sources without a host probe or per-execution recovery scan. **Check host capabilities** explicitly probes the server's host environment; runtime diagnostics have a separate best-effort check. Checks show progress, completion or failure and the last successful check time. Share viewers cannot access these owner diagnostics or send test messages.

Each supported host has its own tab. Switching tabs only changes the view; it does not save scope, probe a host or send a notification. Use the current host’s scope checkbox and save button explicitly; unsaved choices on another tab are not saved. Global source checks and read-only project diagnostics stay outside the tabs. Codex local observation recovery stays in its Codex tab. Host selection controls only which integration configurations are managed and checked; it does not install, uninstall, enable or disable Hooks, notifications or sessions. Explicit saved selection overrides inference. Existing Codex binding, saved Codex notification configuration or an explicit Codex notification environment are compatible selection evidence; an installed CLI alone is not. `PM_SERVER_HOSTS=codex,dsh` can select the check scope when no saved selection exists. DSH exposes lifecycle observation, not bidirectional notifications.

The following capabilities are reported without requiring runtime readiness for workbench access:

| Step | What is checked | Next action |
| --- | --- | --- |
| Runtime observation installation | Managed hook definitions and application state binding match | Run the displayed installation command; an existing service need not restart for this |
| Hook trust and enablement | Public Codex `hooks/list` status for the current hooks | Review and trust in Codex CLI `/hooks`; enable disabled hooks |
| Lifecycle events | A receipt matching the current definition, script and state binding, including a tool completion | Run a session with a tool call, then check again; a generic cache row does not complete this step |
| Manager and execution routes | Current registration and runtime coverage, without requiring sessions to be online | Existing managers reconcile verified routes on a real authorized management request; task viewing is available meanwhile |
| Background notifications | Backend enabled, executable available, arguments a JSON array of strings | Prepared automatically at startup after Codex integration; use Check and connect notifications to retry. Custom settings and explicit disabling take precedence |
| Automatic notification check | The background service detects the first registered manager, sends a check and saves the backend/manager result | Success needs no action. Failures explain the issue and offer Retry; no session IDs or receipt confirmation are required |

Unknown or unsupported host checks stay unverified. They are not treated as missing installation or automatically marked complete. Plain `doctor` checks files and state; add `--check-host` to inspect Hook loading/trust (without querying the account) through the public Codex API:

```sh
pm-server doctor --check-host --json
pm-server status --check-host --json
```

For the same Codex instance, service startup prepares notifications after hook integration without shell exports. The background service discovers manager registration on its normal monitoring cycle (every minute by default) and checks the channel automatically. Only failed checks offer Retry; no manager selection or receipt confirmation is required. Legacy native Codex UUID manager references are supported without modifying task files. Custom backends and explicit disabling take precedence; see Configure reminders for other hosts or instances. CLI testing remains available for automation and advanced use:

```sh
pm-server notification test --manager codex:default:SESSION_ID
# Only after the message actually arrives in that session:
pm-server notification confirm
```

Automatic checks target only a registered manager compatible with the backend. Successful checks are not resent for the same backend/manager. Failed checks retry at most three times, at least five minutes apart; uncertain interrupted sends are not silently repeated. Monitoring and checks share delivery code. Success proves backend acceptance, not actual receipt or manager handling, and requires no manual confirmation. The manual test/confirm commands above remain available for advanced diagnostics. A backend or argument change invalidates old delivery verification. Changed hook definitions, scripts or state bindings require a new lifecycle check. Failed checks retain a reminder and retry action; they never change task status or grant trust.

### Hook permissions, limitations and backups

Hooks run with the current user's permissions and may execute outside the Codex conversation sandbox. Review the source and script before trusting them through `/hooks`; the installer does not grant trust. The observer records runtime status and minimal setup evidence. It does not modify task CSVs/cards or retain prompts, tool inputs, credentials or transcripts.

Hooks require Node.js, an accessible script path and a writable application state directory. Invocations add some overhead; failures or timeouts may affect interaction. Installation backs up existing `hooks.json` and state binding, preserves unrelated hooks and prints backup paths. Restore only the managed configuration to preserve later unrelated changes. Recheck paths, trust and events after upgrades. Setup does not enable OS startup or authorize project execution.

These guides and checks are available starting with 0.1.0-rc.4. Older versions use separate installation and manual verification steps.

## Project registration and blacklist

`pm-server project request` validates the supplied project and registers it immediately. PM Skill manager initialization calls the same public CLI. Repeated requests are idempotent, keyed by the canonical CSV path; this does not scan your disk or start services.

Remove a project in **Settings → Projects** to add it to the persistent **Blacklist**. Repeated requests, including the legacy `--auto` option, cannot rejoin it, even after a restart. Removal disconnects workbench access and monitoring without deleting project files or sessions. **Restore connection** reconnects immediately and retains its project ID. **Unblock** clears the blacklist entry without connecting immediately, allowing a subsequent automatic request. Explicitly adding the project in Settings also restores it.

On startup, the workbench validates and activates older pending connection requests. Invalid sources stay visible under **Connections to retry**, with the error and a retry action. Existing removal records remain blacklisted. Registration is separate from manager takeover and task execution authorization. Older servers may still return `pending`; use that version's confirmation flow or upgrade the server.


## Connect a platform

```sh
pm-server adapter list
pm-server adapter install codex --dry-run
pm-server adapter check codex
```

The legacy Codex installer is available through `adapter install codex`. It merges configuration with a backup. Verify the target host's actual Hook format, events and trust mechanism before using it. A configuration check is not proof of native event delivery.

For DSH, point the actual host configuration at `adapters/dsh/observer.js` in the installed package. It uses only Cordis `apply(ctx)` and three `agent/*` events. See the [adapter guide](../adapters/dsh/README.md). Verify the configured path and module reload after upgrades.

### Standard events

```sh
printf '%s\n' '{"session_id":"session-1","status":"running","turn_id":"turn-1","event_id":"event-1"}' \
  | pm-server event ingest --host claude-code --instance main
```

Supported states are `idle/running/waiting/interrupted/ended/unknown`. Unknown values stay unknown. New integrations use encoded `host:instance:session` references; project routes must use the same references.

Provide `occurred_at` and `sequence` when the source supplies reliable ordering. An ambiguous terminal event must not end a newer turn. Events are committed directly using serialized atomic writes; there is no offline inbox or unlimited retry promise.

`CODEX_SESSION_RUNTIME_CSV` is a legacy single-host bridge. Explicitly enabling it keeps native IDs for the historical Hook/DSH writers. Use the default application path and qualified references for new multi-platform installations.

## Configure reminders

Automatic delivery is disabled until a verified backend is explicitly configured:

```sh
export PROJECT_MANAGER_NOTIFY_BIN=/absolute/path/to/notifier
export PROJECT_MANAGER_NOTIFY_ARGS='["--to","{manager}","--message","{message}"]'
```

`{manager}`, `{message}` and `{kind}` are replaced as argument strings, without a shell. The backend must understand qualified session references and route to the right platform. The historical Codex queue is available only when `PROJECT_MANAGER_CODEX_BIN` is explicitly set; validate it in the target environment.

Deduplication and pauses live in the application's `monitor/` directory. Monitoring does not write `TASKS.csv`, task cards or logs. Accepted delivery is not proof that a manager handled a reminder; timeouts and crashes can cause duplicates.

```sh
pm-server monitor pause --repo /project --task ABC-001 \
  --until 2099-01-01T00:00:00Z --reason 'Waiting for an agreed result' --actor 'Project manager'
pm-server monitor resume --repo /project --task ABC-001 \
  --reason 'Resume checks' --actor 'Project manager'
```

## Development and release

```sh
npm ci --ignore-scripts
npm test
npm pack --dry-run
```

Tests use temporary state and random ports and require loopback access. Browser suites are in `scripts/*browser-test.mjs`; provide an explicit `--output` directory and the actual `--playwright` module path. The bilingual suite covers automatic locale selection, manual overrides, task-detail inheritance and unchanged task data.

The two projects have independent versions and share the public contract in `contracts/protocol.json`. PM Server never imports PM Skill source. Both projects use the MIT license. npm releases are separate from repository pushes; existing host-integration limitations still apply.

### Runtime observation recovery

Workbench basics check readable project sources. Manager registration, online sessions, AI host login, Hook trust, observation samples and notification readiness are optional capabilities in separate diagnostics and do not block task viewing. The collapsed Runtime diagnostics section can optionally diagnose registered active execution sessions and restore observation records from recognized local Codex session logs. The background monitor uses the same bounded adapter. It verifies the session identity and project directory, reads a bounded part of the matching log, and stores only status, event time and observation provenance in the private application cache. It does not start sessions, change task records, trust Hooks or produce Hook execution receipts.

Log observations describe activity at the recorded time. They are not proof that work is still running or that delivery passed acceptance. Missing, unreadable, stale, unsupported or mismatched records remain unverified with a reason; unsupported hosts require their own observation adapter. Quiet inactive observations use a longer freshness window than active observations.

Manager/session readiness and execution observation gaps are capability diagnostics, not unfinished workbench setup. Owner authentication, share permissions, CSRF and source isolation remain enforced. A currently missing record does not prove that a session was never observed or that migration succeeded. Such gaps remain visible in runtime diagnostics without recurring manager notifications solely for missing observations. Known stale or unusable observations and inactive/interrupted handoffs retain their reminder rules. An explicitly registered project manager takes priority over older task-level manager routes for channel checks and reminders; task routes remain unchanged until the manager reconciles confirmed facts during later authorized coordination. Read-only status checks do not start that coordination.
