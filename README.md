<!-- English counterpart of README.zh.md -->

# api_thinking

English | [中文](README.zh.md)

[![test](https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode/actions/workflows/test.yml/badge.svg)](https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A **DSH (DeepSeek Harness) profile bundle** that reads each third-party model's
thinking levels from the **endpoint's own model listing** and keeps `llm-pi-ai`'s
`reasoningEfforts` in sync, so the composer offers the levels a model really has.

## Why

A hand-declared pi-ai route replaces the installed catalog, so `dsh-llm-pi-ai`
reports `reasoning: false` for its models unless the entry declares
`reasoningEfforts` itself — and the composer then offers no thinking levels.
OpenAI-compatible gateways usually publish that capability already
(`reasoning_supported_efforts`, `can_disable_thinking`, `supports_reasoning`);
this plugin reads it and writes the levels back into the profile.

## Rules

| The endpoint says | written `reasoningEfforts` |
|---|---|
| a selectable set | `{ low: low, high: high, ... }`, filtered to the levels DSH can name, in escalation order |
| no set, but one pinned effort (`reasoning_effort: high`) | that single level — the picker shows High, which is what the model actually runs at (selecting it is a no-op). `fixedEffortAsLevel: false` turns this off |
| `supports_reasoning: false` | `false` |
| reasoning, but neither a set nor a pinned effort | the key is **removed** |
| nothing at all about reasoning | **untouched** |
| the model is not listed | **untouched** |

The last two are deliberate: LiteLLM, vLLM and most self-hosted gateways publish
no capability data, and treating silence as "no levels" would erase hand-written
configuration. The plugin only writes what the endpoint actually states.

`includeOff` defaults to off, because the pi-ai adapter sends the mapped `off`
value whenever no level is selected — exposing it would silently make "provider
default" mean "no thinking" for every model that allows disabling thinking.

## Config

```yaml
- insert:
    - id: api-thinking
      name: dsh-api-thinking
      config:
        entryId: llm-pi-ai
        routes: []           # [] = every openai-compatible route
        intervalMs: 120000   # re-sweep cadence; 0 = sweep once after load
        startDelayMs: 3000
        timeoutMs: 15000
        includeOff: false
        fixedEffortAsLevel: true   # show a pinned effort as the only level
        log: true
        statusFile: ''       # '' = $DSH_HOME/api-thinking.status.json, false = none
```

Read the status document first when asking "why did nothing happen": every load
and every sweep records its per-route listing count, planned changes, the write
channel it used and any error.

## Lifecycle

The plugin owns exactly one thing: the levels of models **that are already
configured**. Every sweep re-walks every route of the row (no per-route opt-in,
unless you narrow it with `routes:`), so:

| You do this | The plugin does this |
|---|---|
| add a provider route in the Models page | reads its `baseURL` + `apiKeyEnv` and writes the levels **within seconds** — no plugin change, no restart (measured: 8s) |
| add models to an existing route | same |
| delete a route or a model | its models and their `reasoningEfforts` go away with it; the plugin never re-creates them (it has no code path that adds an entry — it only rewrites that one field of entries that already exist). Measured: after deletion the sweep returns to `changes=0 wrote=false` |
| re-fetch a route's models in the Models page | the form writes only the fields it knows (id/name/contextWindow/maxTokens), so **the levels are wiped** and the next sweep restores them — which is the point of this plugin |
| the upstream gateway gains a model (no local file change) | the interval sweep covers it (≤ `intervalMs`, 120s default) — there is no local file event to react to |

Three triggers: `start` (3s after load), `config-change` (HMR's config watcher on
the profile patch, 2s debounce) and `interval` (the backstop). Every sweep
re-reads the row's `providers` from the profile layers
(`configEditor.configuration()`) rather than from the snapshot the plugin was
instantiated with, which is what makes a just-saved route visible immediately.

## Plugin form

It is a standard DSH/Cordis plugin mounted as a **profile bundle**
(`dsh.bundle.patch` + `dsh.profile.bundles` + a dependency), exactly like
`dsh-ops`, `dsh-better-sidebar` and `dshmarket` in this profile, and exactly the
local-path form the plugin manager's `install_bundle` accepts. The body uses the
standard contract (`name` / `inject` / `apply` / `ctx.effect` / `ctx.logger`) and
prefers the official `ctx.configEditor.edit()` for writes.

What it is not: published to npm (it installs from GitHub), and — deliberately —
it imports nothing, so it has no `Config` schema and no `peerDependencies`. A
package linked from outside the profile directory cannot resolve the harness's
`node_modules` through Node's ESM resolution, so config is validated by hand in
`normalizeConfig()`; the side effect is that the settings UI cannot derive a form
for it and its config is edited as YAML. Installing from npm would lift that,
since the dependency then lives in the package's own `node_modules`. There is no
client half (no settings page, slots or locale dictionary), and
`README.i18n.yaml` is a monorepo-internal translation record, not part of the
plugin form.

## Two write channels

| Channel | When | What |
|---|---|---|
| `config-editor` | normal | `ctx.configEditor.edit()` — file lock, schema validation, Loader reconciliation |
| `patch-file` | when the above answers `HMR transactions cannot be nested` | edits the profile patch directly; the same watcher recomposes it |

The fallback is required: `dsh-hmr` marks transactions with `AsyncLocalStorage`
and rejects nesting. A plugin that was **hot-reloaded** applies inside the very
transaction that replaced it, so the `setInterval` it registers inherits that
store forever and every later `config-editor` call is refused. The fallback
touches only the target models' `reasoningEfforts` (located by indentation,
written to a temp file and renamed), leaving comments and every other field
byte-identical.

## Install

Installed as a **profile bundle**: the package declares `dsh.bundle.patch`, and
the profile lists it as a dependency plus in `dsh.profile.bundles`.

```bash
git clone https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode.git ~/dsh-api-thinking
cd ~/dsh-api-thinking
node tools/install_bundle.mjs --dry-run   # see what it would do
node tools/install_bundle.mjs             # link this directory into the profile
```

The script validates the package, backs up the profile's `package.json` and
lockfile, runs `pnpm add "link:<this directory>"`, appends `dsh-api-thinking` to
`dsh.profile.bundles`, and finally imports it the way the loader will. Useful
flags: `--dest <dir>` (copy somewhere first), `--profile-dir <dir>` (defaults to
`$DSH_HOME/profiles/$DSH_PROFILE`, then `~/.dsh/profiles/desktop`).

> **Overriding a bundle row**: `applyEntryPatches` silently skips a patch whose
> `name` differs from the existing entry (`patch: name mismatch ... skipping`).
> A profile-side override must repeat `name: dsh-api-thinking` word for word.

## Live reload

`hmr` ships `root: []`, so **plugin source changes need a restart** unless the
directory is watched:

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root:
      - '/path/to/dsh-ThirdApi-ThinkingMode'
```

Note that a config-only change reuses the loader's cached module; only a module
replacement (or a restart) picks up new code.

## Verify

```bash
node test/sweep.test.mjs                        # 13 checks: pure logic, patch edits, real gateway catalog
node tools/check_live.mjs                       # profile vs gateway, per model; drift must be 0
node tools/simulate_new_model.mjs cn:glm-5.3    # strip a model's levels, watch them come back
```

Measured on this machine: 51 models, **drift 0**; stripping `cn:glm-5.3` and
`global:gpt-5.5` was repaired within 6 seconds (`reason=start wrote=true
via=patch-file changes=2`) touching only those two models.
