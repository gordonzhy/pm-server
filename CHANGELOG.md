# Changelog

## 0.1.0-rc.16

- Stream large Hook events while retaining only allowlisted observation metadata.
- Bound parsing and cache waits, with rate-limited diagnostics when optional observation storage is unavailable.

## 0.1.0-rc.15

- Invoke the companion skill as `$project-manager` in onboarding prompts.

## 0.1.0-rc.14

- Group required integration configuration by selected host without making host readiness a workbench access requirement.
- Treat Codex Hook return and notification send configuration separately from deferred runtime evidence; remove login checks from onboarding.
- Allow owners to save a reversible host check scope without changing Hooks, notifications or sessions.

## 0.1.0-rc.13

- Keep workbench access independent of manager sessions, AI host readiness and notification capabilities.
- Separate basic source checks from optional session, runtime and notification diagnostics.
- Preserve observation warnings while treating missing runtime coverage as a diagnostic.

## 0.1.0-rc.12

- Diagnose and restore registered Codex execution observations from bounded, verified local session records.
- Share recovery and evidence freshness rules between setup checks and background monitoring, preserving original event times and observation sources.
- Explain recovery results and unresolved observation reasons without starting tasks, changing routes or claiming Hook execution.

## 0.1.0-rc.11

- Separate setup actions from checks that have not yet been verified.
- Show progress, unchanged or updated results, completion time and recoverable errors when checking setup again.
- Recheck the public host API on explicit requests instead of reusing a recent result.

## 0.1.0-rc.10

- Make setup prompt and command copying work when the Clipboard API is unavailable or denied, with nearby feedback and a selected manual-copy fallback.

## 0.1.0-rc.9

- Treat control peers closing during monitor shutdown as unavailable rather than failing the stop operation.
- Use fixed onboarding prompts without project data.
- Restrict shares to server-generated, de-identified progress, dependencies and safe resources; keep owner data private.
- Remove task, path and runtime identities from notification bodies.


[English](CHANGELOG.md) · [简体中文](CHANGELOG.zh-CN.md)

## 0.1.0-rc.8

- Keep the manager setup prompt available after registration.
- Show task status synchronization separately, with affected projects and tasks and a copyable manager check prompt in both languages.

## 0.1.0-rc.7

- Read project manager registration before any task exists.
- Separate missing task routes from missing or stale execution observations; match legacy Codex UUIDs to qualified cache identities.

## 0.1.0-rc.6

- Show clear PM Skill startup steps and a copyable manager-registration prompt.
- Check notifications automatically when a registered manager is first detected; persist results, suppress repeated sends, bound retries and show only failures. Remove session selection and manual receipt confirmation from onboarding.

## 0.1.0-rc.5

- Automatically prepare the default Codex notification channel on service startup after Codex integration, preserving custom backends and explicit disabling.
- Choose a registered manager and test background delivery with buttons in the bilingual workbench; no session ID or shell command is needed.

## 0.1.0-rc.4

- Make `pm-server setup` an interactive, resumable CLI guide; require explicit `--json` automation and persist the credential-free Codex notification preference.

- Add an owner-only bilingual setup checklist with persistent reminders, public Codex trust/account checks, candidate-bound lifecycle receipts, and explicit notification tests and receipt confirmation.
- Add explicit Codex setup that installs runtime hooks and starts the service; expose missing hook/trust/observation/notification checks instead of treating service startup as full readiness.

## 0.1.0-rc.3

- Register valid projects automatically on connection requests; no approval step is required.
- Keep removed projects in a persistent blacklist, with explicit restore and unblock actions.
- Validate and upgrade older pending requests at workbench startup; retain invalid sources with errors for retry.

## 0.1.0-rc.2

- Prepare the first npm preview under `next`, with an MIT license and registry installation instructions.

- Add English and Simplified Chinese across login, workbench, settings, sharing, notifications and embedded task details.
- Automatically follow the browser's preferred language; remember manual overrides and provide a System default option.
- Localize presentation without changing task content, file paths, CSV values or filter identities.
- Make English the default repository README, with linked Chinese documentation.
- Add real-browser language and data-integrity regression coverage.

## 0.1.0-rc.1

First standalone application candidate: split the workbench, monitoring and runtime observation from project-manager into the pm-server CLI. Move notification state outside task files, disable notification delivery by default, qualify session IDs by host and instance, and remove runtime dependency on the Skill installation path.

Fix a monitor-stop race where a connection could close before its response was flushed. Treat an empty control response as unavailable. Add the standard CSV default for project connection requests and a public application health contract.

Native platform integration and additional operating systems remain subject to validation.
