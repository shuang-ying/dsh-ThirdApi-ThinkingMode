<div align="center">

# api_thinking

**Reads each third-party API's own model listing and syncs every model's real thinking levels into DSH**

[中文](README.zh.md) · [MIT](LICENSE)

[![npm package](https://img.shields.io/npm/v/dsh-api-thinking.svg?label=npm%20package)](https://www.npmjs.com/package/dsh-api-thinking)
[![npm downloads](https://img.shields.io/npm/dt/dsh-api-thinking.svg?label=npm%20downloads)](https://www.npmjs.com/package/dsh-api-thinking)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![test](https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode/actions/workflows/test.yml/badge.svg)](https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode/actions/workflows/test.yml)

</div>

> api_thinking is a community-maintained DeepSeek Harness (DSH) plugin. It is not a DeepSeek AI product.

## The problem it solves

DSH's built-in model catalogue does not contain your third-party APIs. To get them into the model picker at all, you declare an `llm-pi-ai` route by hand and list its `models:` yourself.

But **a hand-written `models:` list replaces the installed catalogue outright**. Those models are neither in the catalogue nor declare `reasoningEfforts`, so `dsh-llm-pi-ai` treats them as non-reasoning and **the composer offers no thinking levels**.

Writing the levels into YAML fixes that once — and goes stale immediately: nobody adds them when the gateway ships a new model, and nobody updates them when upstream changes what it supports.

Yet an OpenAI-compatible gateway **usually already publishes that capability in its own model listing**. This plugin reads it and writes the result back into your configuration, so you stop maintaining that YAML by hand.

## Features

- **Automatic level sync** — requests each route's model listing and writes the levels the endpoint publishes into the matching model's `reasoningEfforts`.
- **New APIs just work** — add a route, or add models to an existing one; no plugin change, no restart.
- **Never invents capability** — an endpoint that says nothing about reasoning is left exactly as it is; hand-written levels are never erased.
- **Owns exactly one field** — it owns `reasoningEfforts` and nothing else; comments, `!!js` expressions and every other field stay as they were.
- **Idempotent** — a sweep that finds nothing to change writes no file at all.
- **Self-diagnosing** — every load and every sweep records a status document, so there is always something to read when it misbehaves.

## Install

Requires a working DeepSeek Harness installation. The examples use the `desktop` profile — substitute your own profile name.

### From the plugin page

Open **Settings → Plugins** in the DSH web UI, search for `dsh-api-thinking` and install it. An agent can also call the plugin manager's `install_bundle` directly.

### From the command line

```bash
dsh plugin --profile desktop add dsh-api-thinking
```

Restart DSH and refresh the page afterwards.

### Let an agent do it

Paste this to an agent that can run terminal commands and is connected to your DSH:

```text
Install dsh-api-thinking into my DSH profile, confirm it is active, and tell me how to reload.
```

### Uninstall

Switch it off or uninstall it from the plugin page, or remove the `dsh-api-thinking` dependency from that profile's `package.json` and delete it from the `dsh.profile.bundles` array.

## Usage

It works as soon as it is installed — **there is no switch to turn on**. The plugin walks every route under the `llm-pi-ai` row:

| What you want | How |
| --- | --- |
| Get thinking levels on a model | Configure the route and its models in **Settings → Models** and give it a moment |
| Add a new API | Add it in the model page; the levels follow on their own |
| Narrow the scope | Set `routes` to the route names you care about; the default covers every OpenAI-compatible route |
| Change the sweep cadence | Set `intervalMs`; `0` means "sweep once after load, then stop" |
| Find out why nothing happened | Read the status document — see [Troubleshooting](#troubleshooting-why-nothing-happened) |

## Rules

A model's capability comes from the **first matching field** in the endpoint's model listing:

| Purpose | Fields, in priority order |
| --- | --- |
| Selectable levels | `reasoning_supported_efforts` → `supported_efforts` → `reasoning_efforts` |
| Whether thinking can be turned off | `can_disable_thinking` → `reasoning_can_disable` |
| Whether it reasons at all | `supports_reasoning` → `reasoning` |
| A pinned effort | `reasoning_effort` → `fixed_effort` → `effort` |

What gets written:

| The endpoint says | Written `reasoningEfforts` |
| --- | --- |
| A selectable set | `{ low: low, high: high, ... }`, filtered to the levels DSH can name (`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`), in escalation order |
| No set, but one pinned effort | That single level — the picker shows what the model actually runs at (selecting it is a no-op). Turn off with `fixedEffortAsLevel: false` |
| Explicit `supports_reasoning: false` | `false` |
| It reasons, but publishes neither a set nor a pinned effort | **The key is removed** (writing `false` would claim it does not reason) |
| **Nothing at all about reasoning** | **Left untouched** |
| **The model is not in the listing** | **Left untouched** |

The last two are deliberate safety design: LiteLLM, vLLM and most self-hosted gateways publish no capability data, and treating that silence as "no levels" would erase hand-written configuration. **The plugin only ever acts on what the endpoint actually states.**

`includeOff` defaults to off. When no level is selected, the pi-ai adapter sends the mapped `off` value as the default — so adding `off` to a model that allows disabling thinking would silently turn "provider default" into "no thinking". It has to be enabled explicitly.

## Configuration

```yaml
- insert:
    - id: api-thinking
      name: dsh-api-thinking
      config:
        entryId: llm-pi-ai
        routes: []
        intervalMs: 120000
        startDelayMs: 3000
        timeoutMs: 15000
        includeOff: false
        fixedEffortAsLevel: true
        log: true
        statusFile: ''
```

| Option | Default | Meaning |
| --- | --- | --- |
| `entryId` | `llm-pi-ai` | The profile row to read and write |
| `routes` | `[]` | Route names to manage; `[]` means every OpenAI-compatible route |
| `intervalMs` | `120000` | Re-sweep interval in milliseconds; `0` sweeps once after load |
| `startDelayMs` | `3000` | Delay before the first sweep, to let the profile finish loading |
| `timeoutMs` | `15000` | Per-endpoint model-listing timeout |
| `includeOff` | `false` | Expose `off` as a selectable level (see the caveat above) |
| `fixedEffortAsLevel` | `true` | Show a pinned effort as the single level |
| `log` | `true` | Log every change and every skipped route |
| `statusFile` | `''` | Status document path; `''` means `$DSH_HOME/api-thinking.status.json`, `false` disables it |

> **Overriding the bundle row**: an override in your profile patch must repeat `name: dsh-api-thinking` word for word, or `applyEntryPatches` skips it silently.

## When it runs

| Trigger | When | What it covers |
| --- | --- | --- |
| `start` | `startDelayMs` after load (3s by default) | Full calibration on boot or reload |
| `config-change` | After the profile patch changes (via the HMR config watcher, 2s debounce) | APIs, routes and models you just added or edited |
| `interval` | Every `intervalMs` (120s by default) | Backstop for upstream model and capability changes |

Every sweep re-reads the row's `providers` from the composed profile layers rather than from the snapshot the plugin was instantiated with — which is what makes a route you just saved visible immediately.

## Troubleshooting: why nothing happened

The host logger is not reliably reachable from a plugin, so every load and sweep writes its result to a status document (by default `$DSH_HOME/api-thinking.status.json`):

```json
{
  "phase": "sweep", "reason": "interval", "wrote": true, "via": "patch-file", "error": null,
  "routes": [{ "route": "my-gateway", "models": 20, "listed": 51,
               "changes": [{ "id": "example-model", "to": { "low": "low", "high": "high" } }],
               "dropped": [], "error": null }]
}
```

Read these first:

| Field | Meaning |
| --- | --- |
| `phase` | Current stage (`apply` / `sweep`) |
| `error` | Failure reason, including request errors the UI never shows |
| `listed` | How many models the endpoint returned |
| `models` | How many the route has configured |
| `changes` | Which models this sweep planned to change |
| `wrote` / `via` | Whether it wrote, and through which channel |

A non-empty `listed` with an empty `changes` usually means the endpoint publishes no reasoning capability — see [Rules](#rules).

## Write channels

The plugin prefers the official channel and only falls back when it has to:

| Channel | When | What |
| --- | --- | --- |
| `config-editor` | Normal case | `ctx.configEditor.edit()` — the official path, with file locking, schema validation and Loader reconciliation |
| `patch-file` | When the above answers `HMR transactions cannot be nested` | Edits the profile patch directly; the same config watcher recomposes it |

The fallback is unrelated to how the plugin was installed: a **hot-reloaded** plugin runs its `apply()` inside the very HMR transaction that replaced it, after which every write through the official channel is refused as a nested transaction. The fallback touches only the target models' `reasoningEfforts` (located by indentation, written to a temp file and renamed), leaving comments and every other field byte-identical.

## Known limitations

- It reads the **model listing** as its only source of capability. An endpoint that publishes nothing about reasoning is left alone.
- Only protocols that can list models are supported: `openai-completions`, `openai-responses`, `anthropic-messages`.
- Models are matched by exact id; no aliases or fuzzy matching.
- The default meaning of `off` is constrained by the pi-ai adapter, which cannot express "selectable but not the default".
- The fallback channel does no schema validation, only structural location.
- Writing `cordis.patch.yml` at the same time as the settings page can in theory overwrite each other; the next sweep converges again (it is idempotent).

## Feedback and contributing

Found a bug or have a suggestion? Please [open an issue](https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode/issues) with your DSH version, the plugin version and reproduction steps.

```bash
npm test                              # 15 checks: pure logic, patch edits, composed config, real gateway catalogue
node tools/check_live.mjs             # live profile vs gateway, per model; drift should be 0
node tools/diff_gateway_profile.mjs   # "why is my new API missing": gateway vs profile, per model
```

The maintenance tools infer locations from the environment (`DSH_HOME` / `DSH_PROFILE`, or `API_THINKING_PROFILE_DIR` / `API_THINKING_PROFILE`) and read the gateway from `API_THINKING_BASE_URL` (optionally with `API_THINKING_API_KEY`) or `API_THINKING_GATEWAY_CONFIG` (a config.json holding `{ listen, api_key }`).

## License

[MIT](LICENSE)
