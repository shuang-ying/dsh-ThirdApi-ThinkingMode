---
description: "从第三方端点自己的模型清单里读出每个模型的思考档位，并同步进 llm-pi-ai 的 reasoningEfforts。"
kind: "plugin-reference"
---

# api_thinking

[English](README.md) | 中文

[![test](https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode/actions/workflows/test.yml/badge.svg)](https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个 **DSH（DeepSeek Harness）profile bundle**：从每个第三方端点**自己的模型清单**里读出该模型真正
支持的思考档位，写进 `llm-pi-ai` 路由的 `reasoningEfforts`，让 composer 的模型选择器出现真实可选项。

## 为什么需要它

pi-ai 路由一旦手写 `models:` 列表，就**整体替换**了内置目录；这些模型既不在已安装目录里、也没声明
`reasoningEfforts`，于是 `dsh-llm-pi-ai` 走 `base?.reasoning ?? false` 分支，模型被判定为"不支持推理"，
**composer 的模型选择器就不会出现思考强度**。

手工把档位写进 YAML 能解决一次，但会立刻过期：新模型加进来没人补，上游改了支持集合也没人改。
而 OpenAI 兼容网关**自己的模型清单里通常就带着这个能力**（wb2api 会返回
`reasoning_supported_efforts` / `can_disable_thinking` / `supports_reasoning`）。
本插件读它，并把结果写回 profile 的配置里。

## 判定规则

每个模型读第一个命中的字段：

| 用途 | 字段（按优先级） |
|---|---|
| 可选档位 | `reasoning_supported_efforts` → `supported_efforts` → `reasoning_efforts` |
| 能否关闭思考 | `can_disable_thinking` → `reasoning_can_disable` |
| 是否为推理模型 | `supports_reasoning` → `reasoning` |

然后：

| 端点说 | 写入的 `reasoningEfforts` |
|---|---|
| 公布了可选档位 | `{ low: low, high: high, ... }`，只取 DSH 能命名的档位（`off/minimal/low/medium/high/xhigh/max`），按升高顺序 |
| 没公布集合、但钉死了一个档位（`reasoning_effort: high`） | 就把**那一个**档位写进去 —— 选择器显示 High，那是它实际跑的档位（选中是同值，行为不变）。`fixedEffortAsLevel: false` 可关掉 |
| 明确 `supports_reasoning: false` | `false` |
| 说了有推理，但既没集合也没钉死档位 | **删除该键**（写 `false` 等于谎称它不推理） |
| **对推理完全沉默** | **不动** |
| **清单里没有这个模型** | **不动** |

最后两条是刻意的安全设计：LiteLLM / vLLM / 多数自建网关什么都不公布，如果把它们当成"没有档位"，
插件会把用户手写的档位全部抹掉。**插件只在端点真的开口谈推理时才动手。**

`includeOff` 默认关闭。pi-ai 在"未选任何档位"时会把映射表里的 `off` 值当作默认值发出去，所以给
可关思考的模型加上 `off: off` 会让"提供方默认"实际等于"不思考"——它必须由你显式打开。

## 配置

```yaml
- insert:
    - id: api-thinking
      name: dsh-api-thinking
      config:
        entryId: llm-pi-ai      # 读写的 profile 行
        routes: []              # [] = 所有 OpenAI 兼容路由；可列路由名收窄
        intervalMs: 120000      # 重新扫描周期；0 = 只在加载后扫一次
        startDelayMs: 3000      # 首次扫描延迟，等 profile 加载完
        timeoutMs: 15000        # 单个端点清单请求超时
        includeOff: false       # 是否暴露 off（见上文副作用）
        fixedEffortAsLevel: true # 端点钉死档位时是否把它显示为唯一档位
        log: true               # 每次改动与跳过的路由都写日志
        statusFile: ''          # 状态文档路径；'' = $DSH_HOME/api-thinking.status.json
                                # false = 不写
```

## 生命周期：新 API 会自动加入，删除 API 不需要清理

插件的职责边界是**"已经在配置里的模型"的档位**。它每次扫描都重新遍历该行 `providers` 的**所有路由**
（没有按路由的开关，也没有白名单，除非你用 `routes:` 收窄），所以：

| 你的动作 | 插件的反应 |
|---|---|
| 在「设置 → 模型」新增一条 API 路由（含 models） | **秒级**自动读取该路由的 `baseURL` + `apiKeyEnv`，按上表写档位。**不用改插件、不用重启**。实测：保存后 **8 秒**内档位就位 |
| 给已有路由新增模型 | 同上 |
| 删除路由 / 删除模型 | 该路由的模型连同它们的 `reasoningEfforts` 一起消失，**插件不会重新创建**（它没有任何"新增条目"的代码路径，只改已存在条目的这一个字段）。实测：删除后扫描回到 `changes=0 wrote=false`，文件里再无该路由 |
| 在 Models 页重新拉取某路由的模型 | 表单只会写它知道的字段（id/name/contextWindow/maxTokens），**档位会被清掉**，随后自动补回 —— 这正是本插件存在的理由 |
| 上游网关新增了模型（本地文件没动） | 由周期扫描覆盖（≤ `intervalMs`，默认 120 秒）—— 这种情况没有本地文件事件，只能轮询 |

### 三个触发源

| 触发 | 时机 | 覆盖什么 |
|---|---|---|
| `start` | 插件加载后 `startDelayMs`（3 秒） | 启动/重载时的全量校准 |
| `config-change` | profile patch 被改动后（HMR 的 config watcher，2 秒防抖） | 你新增/修改 API、路由、模型 |
| `interval` | 每 `intervalMs`（默认 120 秒） | 兜底：上游网关侧的模型/能力变化 |

每次扫描都**从 profile 层重新组合读取**该行的 `providers`（`configEditor.configuration()`），
而不是读插件实例化时的那份快照 —— 这正是"刚保存的路由立刻被看见"的原因。早期版本读快照，
所以会晚一个 Loader 更新周期才生效。

### 状态文档

宿主 logger 在插件里不保证可达（桌面端没有控制台），所以每次加载与每次扫描都会把结果写进状态文档：

```json
{
  "phase": "sweep", "reason": "interval", "wrote": true, "via": "patch-file", "error": null,
  "routes": [{ "route": "localcn", "models": 20, "listed": 51,
               "changes": [{ "id": "cn:glm-5.3", "to": { "low": "low", "high": "high", "max": "max" } }],
               "dropped": [], "error": null }]
}
```

排查"为什么没生效"时先看这里：`phase`（apply / sweep）、`error`（例如浏览器侧看不到的抓取失败）、
`listed`（端点数了多少模型）、`changes`（计划改什么）、`via`（走哪条写通道）。

## 写入通道：两条，自动择一

| 通道 | 何时使用 | 说明 |
|---|---|---|
| `config-editor` | 正常情况 | `ctx.configEditor.edit()`：官方路径，带文件锁、schema 校验、Loader 对账 |
| `patch-file` | 上面那条报 `HMR transactions cannot be nested` 时 | 直接改写 profile patch，由**同一个 watcher** 重组 |

第二条是必需的，原因是 `dsh-hmr` 用 `AsyncLocalStorage` 标记事务（`runExclusive` 直接拒绝嵌套）：

```js
runExclusive(operation) {
  if (this.executing.getStore()) return Promise.reject(new Error("HMR transactions cannot be nested"))
```

插件**被热重载**时，它的 `apply()` 是在替换它的那次 HMR 事务里跑的，于是 `apply()` 里注册的
`setInterval` 回调**永久继承**了那个 store —— 之后每次定时扫描调用 `config-editor` 都被判为嵌套事务。
回退通道把改动写进 `cordis.patch.yml`（只动目标模型的 `reasoningEfforts`，按缩进定位、临时文件 +
rename、注释与其它字段一律不碰），HMR 的配置监听会照常重组，效果与官方路径一致。

## 安装

三种方式效果相同 —— 最终都落到 profile 的依赖 + `dsh.profile.bundles`（包内 `package.json` 声明
`dsh.bundle.patch`，这就是 DSH 的 **bundle** 形态）。**前两种就是 DSH 标准插件安装**：由插件管理器
执行，会先做 DSH 版本兼容检查，装完自动重载 profile。

### 1. 插件页 / `plugin_manager` 工具（标准）

在「设置 → 插件」页，或让 Agent 用 `plugin_manager` 的 `install_bundle`，填入 spec：

| spec | 何时可用 |
|---|---|
| `dsh-api-thinking` | 发布到 npm 之后（包名已确认未被占用） |
| `github:shuang-ying/dsh-ThirdApi-ThinkingMode` | **现在就能用**（管理器支持 git spec，本机已实测） |
| `https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode` | 同上（git / tarball 形式） |
| `/绝对/路径/dsh-ThirdApi-ThinkingMode` | 本地目录（开发用） |

底层就是 `pnpm add <spec>` 再把 `dsh-api-thinking` 追加进 `dsh.profile.bundles`。

### 2. 命令行等价

```bash
cd ~/.dsh/profiles/<profile>
pnpm add github:shuang-ying/dsh-ThirdApi-ThinkingMode
# 再把 dsh-api-thinking 追加进 package.json 的 dsh.profile.bundles
```

### 3. 本地目录（开发用，附带脚本）

```bash
git clone https://github.com/shuang-ying/dsh-ThirdApi-ThinkingMode.git ~/dsh-api-thinking
cd ~/dsh-api-thinking
node tools/install_bundle.mjs --dry-run   # 先看它要做什么
node tools/install_bundle.mjs             # 就地把本目录 link 进 profile
```

脚本会：校验包、备份 profile 的 `package.json` 与锁文件、`pnpm add "link:<本目录>"`、
把 `dsh-api-thinking` 追加进 `dsh.profile.bundles`，最后按 Loader 的方式 import 一次做验证。
常用参数：`--dest <dir>`（先复制到别处再装）、`--profile-dir <dir>`（默认 `$DSH_HOME/profiles/$DSH_PROFILE`，
再退到 `~/.dsh/profiles/desktop`）。

**卸载**：从 `dsh.profile.bundles` 移除、删掉该依赖（或在插件页关掉）；也可以在 profile patch 里给它
`disabled: true`。

### 发布到 npm（可选）

```bash
npm login
npm publish        # prepack 会先跑测试，失败则不发布
```

发布后第 1 种方式的 `dsh-api-thinking` 即可用。tarball 只包含 `files` 列出的内容（lib、cordis.patch.yml、
tools、test、README×2、LICENSE，约 36 KB）。

> **覆盖 bundle 行的坑**：`applyEntryPatches` 在 patch 的 `name` 与已有条目不一致时会**静默跳过**
> （`patch: name mismatch for %C ... skipping`）。所以你在 `cordis.patch.yml` 里写覆盖行时，
> `name` 必须与 bundle 层逐字相同（`dsh-api-thinking`），否则那行不生效。

## 改代码后如何生效

`hmr` 条目的 `root` 默认是 `[]`（不监听模块），此时**改插件源码需要重启桌面端**。开发期可以让 HMR
盯着本仓库目录：

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  config:
    root:
      - '/path/to/dsh-ThirdApi-ThinkingMode'
```

之后改 `lib/index.js` 保存即热重载。注意：改完源码仍需等 HMR 重新 import 该模块；条目只改 `config`
时 Loader 会复用已缓存的模块。

## 验证

维护工具都从环境推断位置（`DSH_HOME` / `DSH_PROFILE`，或 `API_THINKING_PROFILE_DIR`、
`API_THINKING_PROFILE`），网关从 `API_THINKING_BASE_URL`（+ `API_THINKING_API_KEY`）或
`API_THINKING_GATEWAY_CONFIG`（一个含 `{ listen, api_key }` 的 config.json）读取：

```bash
export API_THINKING_GATEWAY_CONFIG=/path/to/gateway/config.json   # 只有比对网关的工具需要
node test/sweep.test.mjs            # 15 项：纯逻辑 + patch 改写 + 组合读取 + 真实网关目录交叉验证
node tools/check_live.mjs           # 线上 profile 与网关逐模型比对，drift 必须为 0
node tools/diff_gateway_profile.mjs # "为什么新 API 没出现"：网关 vs profile 逐模型差异
node tools/simulate_new_model.mjs cn:glm-5.3     # 模拟"新模型"：删掉某模型的档位块，等它补回
node tools/simulate_new_route.mjs add|remove x   # 模拟"新增/删除一条 API 路由"
```

本机实测：`check_live.mjs` → 51 个模型 **drift 0**；删掉 `cn:glm-5.3` 与 `global:gpt-5.5` 的档位块后
6 秒内补回；新增一条路由后 **8 秒**内其模型档位就位；删除该路由后扫描回到 `changes=0 wrote=false`，
文件里再无该路由。

## 插件形态：是官方那套，但不是"已发布的官方插件"

**同一套机制**：本包就是一个 DSH/Cordis 插件 + 一个 **profile bundle**（`package.json` 声明
`dsh.bundle.patch`，profile 在依赖里指向它并把它列进 `dsh.profile.bundles`）。这与 `dsh-ops`、
`dsh-better-sidebar`、`dshmarket` 在本 profile 里的挂载方式完全一致，也正是插件管理器的
`install_bundle` 明确支持的"**本地路径**"形态（它会先读该路径的 `package.json`、做 peer 兼容检查，
再 `pnpm add`）。插件体用的是标准契约：`export const name` / `inject` / `export function apply(ctx, config)`，
生命周期用 `ctx.effect`，日志用 `ctx.logger`，配置写入优先走官方 `ctx.configEditor.edit()`。

**不是的部分**（以及为什么）：

| 差异 | 原因 / 影响 |
|---|---|
| 未发布到 npm（可从 GitHub 安装） | 仓库是公开的，`repository`/`homepage`/`bugs` 已填、`private` 已去掉；要发 npm 直接 `npm publish` 即可（`files` 已列好） |
| **零第三方 import**（不 `import { Schema } from '@deepseek-ai/cordis'`），因此没有 `Config` schema，也没有运行时 `dependencies`；唯一的 peer 声明是可选 `@deepseek-ai/cordis`，刻意留 `*`（npm 对 `*` 放行预发布版；换成 `>=4.0.1-rc.1 <5.0.0-0` 这类有界范围，会在新 harness 附带的预发布 cordis 上报 `ERESOLVE`） | 包被 link 在 profile 目录之外时，Node 的 ESM 解析**到不了** harness 的 `node_modules`（`profiles/<name>/node_modules` 不是它的祖先）。所以配置改为在 `normalizeConfig()` 里手工校验。**副作用**：设置页无法从 schema 派生出本插件的配置表单，配置只能手改 YAML。从 npm 安装（依赖装进它自己的 `node_modules`）就没有这个限制 |
| 没有客户端半边（无设置页、无 slot、无 locale 词典） | 它是纯宿主侧服务型插件；`README.i18n.yaml` 是 monorepo 内部的翻译校验记录，不属于插件形态 |
| 回退写通道（直接改 patch） | 官方通道在"被热重载的插件"里会被 HMR 事务嵌套拒绝，见上文；这是对 `dsh-hmr` 行为的一个务实绕行 |

要让"官方通道"始终可用（即去掉回退），可选：把插件发到 npm 并用 `pnpm add` 正常安装（peerDeps 让
pnpm 把 `@deepseek-ai/cordis` 装进它自己的 `node_modules`），或在插件目录里手工建一个指向 harness
`@deepseek-ai/cordis` 的 `node_modules` 链接 —— 但热重载路径下的事务嵌套问题与安装方式无关，
仍会命中。

## 已知限制

- 只读 **模型清单** 这一种能力来源。端点不公布推理能力时插件无能为力（会保持不动）。
- 只支持能列出模型的协议：`openai-completions`、`openai-responses`、`anthropic-messages`。
- 逐模型精确匹配 id，不做别名/模糊匹配。
- `off` 的默认语义受 pi-ai 适配器限制，无法表达"可选但非默认"（那需要路由级 `reasoning`，
  而路由级默认会对该路由每个模型校验，缺档位的模型会直接请求失败）。
- 回退通道不做 schema 校验（官方通道才做），只做结构定位；改坏的可能被下一次扫描覆盖回去。
- 与设置页同时写 `cordis.patch.yml` 时理论上可能互相覆盖；下一次扫描会重新收敛（幂等）。

