/**
 * api_thinking — keep `llm-pi-ai`'s per-model `reasoningEfforts` in sync with
 * what each third-party endpoint actually publishes.
 *
 * Why this exists: a hand-declared pi-ai route replaces the installed catalog,
 * so `dsh-llm-pi-ai` falls back to `reasoning: false` unless the model entry
 * declares `reasoningEfforts` itself — and the composer then offers no thinking
 * levels. Declaring them by hand goes stale the moment a model is added or the
 * upstream changes what it supports. OpenAI-compatible gateways publish that
 * capability in their own model listing; this plugin reads it and writes the
 * levels back through the profile's config editor.
 *
 * Source of truth per model (first key found wins):
 *   levels     reasoning_supported_efforts | supported_efforts | reasoning_efforts
 *   can disable thinking        can_disable_thinking | reasoning_can_disable
 *   reasoning at all            supports_reasoning | reasoning
 *
 * Behaviour: a model the endpoint does not list is left exactly as it is. A
 * model that publishes no selectable set loses the key (DSH then offers no
 * levels, which is the truth) unless the endpoint explicitly says it is not a
 * reasoning model, in which case the key becomes `false`. The plugin owns this
 * field on every route it manages and never touches anything else.
 *
 * Zero third-party imports on purpose: this package lives outside the profile
 * directory, where Node cannot resolve the harness's node_modules.
 *
 * @module dsh-api-thinking
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'

export const name = 'api-thinking'

/** The profile row whose `providers` this plugin reads and owns. */
export const inject = ['configEditor']

/** Every thinking level the pi-ai adapter can name, in escalation order. */
export const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const EFFORT_FIELDS = ['reasoning_supported_efforts', 'supported_efforts', 'reasoning_efforts']
const DISABLE_FIELDS = ['can_disable_thinking', 'reasoning_can_disable']
const SUPPORTS_FIELDS = ['supports_reasoning', 'reasoning']
/** A pinned effort, sent when the endpoint publishes no selectable set. */
const FIXED_FIELDS = ['reasoning_effort', 'fixed_effort', 'effort']

/** Protocols whose model listing this plugin can read. */
const LISTABLE = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])

const DEFAULTS = {
  entryId: 'llm-pi-ai',
  routes: [],
  intervalMs: 120000,
  startDelayMs: 3000,
  timeoutMs: 15000,
  includeOff: false,
  fixedEffortAsLevel: true,
  log: true,
  statusFile: '',
}

/**
 * Normalise plugin config, rejecting what cannot be honoured.
 * @param config - raw config from the profile patch.
 * @returns the resolved options.
 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('api-thinking: config must be a map')
  const opts = { ...DEFAULTS }
  if (raw.entryId !== undefined) {
    if (typeof raw.entryId !== 'string' || raw.entryId.length === 0) throw new TypeError('api-thinking: entryId must be a non-empty string')
    opts.entryId = raw.entryId
  }
  if (raw.routes !== undefined) {
    if (!Array.isArray(raw.routes) || raw.routes.some((r) => typeof r !== 'string')) throw new TypeError('api-thinking: routes must be a list of route names')
    opts.routes = [...raw.routes]
  }
  for (const key of ['intervalMs', 'startDelayMs', 'timeoutMs']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]) || raw[key] < 0) throw new TypeError(`api-thinking: ${key} must be a non-negative number`)
    opts[key] = raw[key]
  }
  for (const key of ['includeOff', 'fixedEffortAsLevel', 'log']) {
    if (raw[key] === undefined) continue
    if (typeof raw[key] !== 'boolean') throw new TypeError(`api-thinking: ${key} must be a boolean`)
    opts[key] = raw[key]
  }
  if (raw.statusFile !== undefined) {
    if (raw.statusFile !== false && typeof raw.statusFile !== 'string') throw new TypeError('api-thinking: statusFile must be a path, an empty string, or false')
    opts.statusFile = raw.statusFile
  }
  return opts
}

/**
 * Pull one capability record out of a listing entry.
 * @param entry - one entry of the endpoint's model listing, or undefined.
 * @returns the capability, or undefined when the endpoint says nothing.
 */
export function readCapability(entry) {
  if (entry === undefined || entry === null || typeof entry !== 'object') return undefined
  const published = EFFORT_FIELDS.map((key) => entry[key]).find((value) => Array.isArray(value))
  const efforts = Array.isArray(published) ? published.filter((value) => typeof value === 'string') : []
  const canDisable = DISABLE_FIELDS.some((key) => entry[key] === true)
  const supports = SUPPORTS_FIELDS.map((key) => entry[key]).find((value) => typeof value === 'boolean')
  // An endpoint that publishes no set but names one pinned effort still tells us
  // what the model runs at; keep it so the picker can say so instead of nothing.
  const fixed = FIXED_FIELDS.map((key) => entry[key]).find((value) => typeof value === 'string')
  if (efforts.length === 0 && canDisable === false && supports === undefined && fixed === undefined) return undefined
  return { efforts, canDisable, supports, ...(fixed === undefined ? {} : { fixedEffort: fixed }) }
}

/**
 * Decide the `reasoningEfforts` value one model should carry.
 * @param capability - the endpoint's capability record, or undefined.
 * @param options - `includeOff` exposes an explicit off when the endpoint allows
 *   it; `fixedEffortAsLevel` (default on) exposes a pinned effort as the single
 *   level when the endpoint publishes no selectable set.
 * @returns an efforts map to write, `false` for a non-reasoning model, `null` to
 *   remove the key, or `undefined` to leave the model exactly as it is.
 */
export function decideEfforts(capability, options = {}) {
  if (capability === undefined) return undefined
  if (capability.efforts.length > 0) {
    const levels = LEVELS.filter((level) => capability.efforts.includes(level))
    if (levels.length === 0) return undefined
    if (options.includeOff === true && capability.canDisable === true) levels.unshift('off')
    return Object.fromEntries(levels.map((level) => [level, level]))
  }
  if (capability.supports === false) return false
  if (options.fixedEffortAsLevel !== false && typeof capability.fixedEffort === 'string' && LEVELS.includes(capability.fixedEffort)) {
    // The endpoint pins this effort and offers nothing to choose, so the picker
    // shows the one value the model actually runs at. Selecting it is a no-op.
    const levels = [capability.fixedEffort]
    if (options.includeOff === true && capability.canDisable === true && !levels.includes('off')) levels.unshift('off')
    return Object.fromEntries(levels.map((level) => [level, level]))
  }
  return null
}

/**
 * Compare a declared `reasoningEfforts` with a decided one, ignoring key order.
 * @param declared - the value currently in the profile.
 * @param decided - the value this plugin wants.
 * @returns whether the two describe the same levels.
 */
export function sameEfforts(declared, decided) {
  if (declared === false || decided === false) return declared === decided
  if (declared === undefined || declared === null || decided === undefined || decided === null) {
    return (declared ?? null) === (decided ?? null)
  }
  if (typeof declared !== 'object' || typeof decided !== 'object') return false
  const keys = (value) => LEVELS.filter((level) => Object.hasOwn(value, level))
  const a = keys(declared)
  const b = keys(decided)
  if (a.length !== b.length) return false
  return a.every((level, index) => level === b[index] && declared[level] === decided[level])
}

/**
 * Read a model listing out of an OpenAI-style or Anthropic-style body.
 * @param body - the parsed response.
 * @returns `{ id, raw }` pairs in endpoint order.
 */
export function readListing(body) {
  const container = body?.data ?? body?.models
  const list = Array.isArray(container)
    ? container
    : container !== null && typeof container === 'object'
      ? Object.entries(container).map(([id, value]) => (value !== null && typeof value === 'object' ? { id, ...value } : { id }))
      : []
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const id = typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined
    if (id === undefined) continue
    out.push({ id, raw: item })
  }
  return out
}

/**
 * Level names an endpoint published that DSH cannot name as a level key.
 * @param capability - the endpoint's capability record.
 * @returns the unusable names, in endpoint order.
 */
export function unusableLevels(capability) {
  if (capability === undefined) return []
  const published = capability.efforts.filter((level) => !LEVELS.includes(level))
  // A pinned effort only matters when it is the one being used.
  const pinned = capability.efforts.length === 0 && typeof capability.fixedEffort === 'string' && !LEVELS.includes(capability.fixedEffort)
    ? [capability.fixedEffort]
    : []
  return [...published, ...pinned]
}

/**
 * Plan one route's model list against the endpoint's listing.
 * @param models - the route's configured model entries (not mutated).
 * @param listing - `{ id, raw }` pairs from the endpoint.
 * @param options - `includeOff`, as in {@link decideEfforts}.
 * @returns the next model list plus the changes that were made.
 */
export function planModels(models, listing, options = {}) {
  const byId = new Map(listing.map((item) => [item.id, item.raw]))
  const next = []
  const changes = []
  const dropped = new Set()
  for (const model of models) {
    if (model === null || typeof model !== 'object' || typeof model.id !== 'string') {
      next.push(model)
      continue
    }
    const capability = readCapability(byId.get(model.id))
    for (const level of unusableLevels(capability)) dropped.add(level)
    const decided = decideEfforts(capability, options)
    if (decided === undefined) {
      next.push(model)
      continue
    }
    if (decided === null) {
      if (!Object.hasOwn(model, 'reasoningEfforts')) {
        next.push(model)
        continue
      }
      const copy = { ...model }
      delete copy.reasoningEfforts
      next.push(copy)
      changes.push({ id: model.id, from: model.reasoningEfforts, to: null })
      continue
    }
    if (sameEfforts(model.reasoningEfforts, decided)) {
      next.push(model)
      continue
    }
    next.push({ ...model, reasoningEfforts: decided })
    changes.push({ id: model.id, from: model.reasoningEfforts, to: decided })
  }
  return { models: next, changes, dropped: [...dropped] }
}

/* ── writing the profile patch directly ───────────────────────────────────── */

/**
 * Plan line edits that bring the model entries of one profile row to `desired`.
 *
 * Pure, and deliberately line-based: the profile patch belongs to its author, so
 * comments, `!!js` expressions and key order outside the touched models are
 * preserved exactly. Every touched model keeps its field order too — its
 * `reasoningEfforts` block is dropped and re-inserted where it already was.
 *
 * @param lines - the patch file's lines, without terminators.
 * @param desired - model id -> efforts map, `false`, or `null` to remove the key.
 * @param options - `entryId` of the row to edit.
 * @returns the next lines plus whether anything moved.
 */
export function planPatchEdits(lines, desired, options = {}) {
  const entryId = typeof options.entryId === 'string' ? options.entryId : 'llm-pi-ai'
  const rowIndex = lines.findIndex((line) => line.trim() === `- id: ${entryId}`)
  if (rowIndex === -1) return { lines, changed: false }
  let end = lines.findIndex((line, index) => index > rowIndex && /^- id: /.test(line))
  if (end === -1) end = lines.length

  const edits = []
  for (let i = rowIndex + 1; i < end; i += 1) {
    const header = /^(\s*)- id: (.+?)\s*$/.exec(lines[i])
    if (header === null) continue
    const id = header[2]
    if (!desired.has(id)) continue
    const idIndent = header[1]
    const fieldIndent = `${idIndent}  `

    // the entry's own field region, delimited by indentation
    let regionEnd = i + 1
    while (regionEnd < end) {
      const line = lines[regionEnd]
      if (/^\s*- id: /.test(line)) break
      if (line.trim() !== '' && line.search(/\S/) <= idIndent.length) break
      regionEnd += 1
    }

    // an existing reasoningEfforts block: its header plus deeper-indented lines
    let dropFrom = -1
    let dropTo = -1
    for (let k = i + 1; k < regionEnd; k += 1) {
      if (!lines[k].startsWith(`${fieldIndent}reasoningEfforts:`)) continue
      let e = k + 1
      while (e < regionEnd && lines[e].trim() !== '' && lines[e].search(/\S/) > fieldIndent.length) e += 1
      dropFrom = k
      dropTo = e
      break
    }

    const value = desired.get(id)
    const block = value === null
      ? []
      : value === false
        ? [`${fieldIndent}reasoningEfforts: false`]
        : [
            `${fieldIndent}reasoningEfforts:`,
            ...LEVELS.filter((level) => Object.hasOwn(value, level)).map((level) => `${fieldIndent}  ${level}: ${value[level]}`),
          ]
    if (block.length === 0 && dropFrom === -1) continue
    edits.push(dropFrom === -1 ? { from: regionEnd, to: regionEnd, insert: block } : { from: dropFrom, to: dropTo, insert: block })
  }

  if (edits.length === 0) return { lines, changed: false }
  const insertAt = new Map()
  const dropped = new Set()
  for (const edit of edits) {
    insertAt.set(edit.from, [...(insertAt.get(edit.from) ?? []), ...edit.insert])
    for (let k = edit.from; k < edit.to; k += 1) dropped.add(k)
  }
  const out = []
  for (let k = 0; k < lines.length; k += 1) {
    if (insertAt.has(k)) out.push(...insertAt.get(k))
    if (dropped.has(k)) continue
    out.push(lines[k])
  }
  return { lines: out, changed: out.length !== lines.length || out.some((line, index) => line !== lines[index]) }
}

/**
 * Apply {@link planPatchEdits} to the profile patch, atomically.
 * @param path - absolute path of the profile patch.
 * @param desired - model id -> efforts map, `false`, or `null`.
 * @param options - `entryId` of the row to edit.
 * @returns whether the file changed.
 */
export function writePatchFile(path, desired, options = {}) {
  const raw = readFileSync(path, 'utf8')
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const planned = planPatchEdits(raw.split(/\r?\n/), desired, options)
  if (!planned.changed) return { changed: false }
  const temporary = `${path}.api-thinking.tmp`
  writeFileSync(temporary, planned.lines.join(eol), 'utf8')
  renameSync(temporary, path)
  return { changed: true }
}

/* ── host wiring ─────────────────────────────────────────────────────────── */

/**
 * Read one profile row's `providers` the way the profile currently composes them.
 *
 * `entry.options.config` is a snapshot from whenever that row was last
 * reconciled, so a route the user saved a moment ago can still be missing from
 * it — and then the detector would look one Loader update late. The config
 * editor's `configuration()` re-reads the profile layers on every call, which is
 * what makes "configure an API and its levels appear" immediate.
 *
 * @param editor - the config editor service.
 * @param entryId - the row to read.
 * @param fallback - the instantiated config, used when the fresh read is unusable.
 * @returns the composed `providers` map, or the fallback.
 */
export function effectiveProviders(editor, entryId, fallback) {
  let rows
  try {
    rows = typeof editor?.configuration === 'function' ? editor.configuration() : undefined
  } catch {
    rows = undefined
  }
  const row = Array.isArray(rows) ? rows.find((candidate) => candidate?.entry?.options?.id === entryId) : undefined
  if (row === undefined) return fallback
  // Per-provider merge: a route the user layer defines replaces the inherited one.
  const providers = { ...(row.inherited?.providers ?? {}), ...(row.override?.providers ?? {}) }
  return Object.keys(providers).length === 0 ? fallback : providers
}

/**
 * Where the status document lives when no explicit path is configured.
 * @returns the status file path under the harness home.
 */
export function defaultStatusFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'api-thinking.status.json')
}

/**
 * Read the endpoint's model listing for one configured route.
 * @param ctx - plugin context, for the optional credentials service.
 * @param route - route name, for diagnostics.
 * @param profile - the route's pi-ai profile.
 * @param options - resolved plugin options.
 * @returns `{ id, raw }` pairs.
 */
async function fetchListing(ctx, route, profile, options) {
  const base = String(profile.baseURL).replace(/\/+$/, '')
  const api = typeof profile.api === 'string' ? profile.api : 'openai-completions'
  const url = api === 'anthropic-messages' ? `${base}/v1/models?limit=1000` : `${base}/models`
  const headers = new Headers(profile.headers ?? {})
  headers.set('accept', 'application/json')

  const ref = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
  let apiKey
  if (ref !== undefined) {
    const credentials = ctx.get('credentials')
    const hit = credentials === undefined ? undefined : await credentials.resolve(ref)
    apiKey = hit?.value ?? process.env[ref]
  }
  if (api === 'anthropic-messages') {
    headers.set('anthropic-version', '2023-06-01')
    if (apiKey !== undefined) headers.set('x-api-key', apiKey)
  } else if (apiKey !== undefined) {
    headers.set('authorization', `Bearer ${apiKey}`)
  }

  const response = await fetch(url, { headers, signal: AbortSignal.timeout(options.timeoutMs) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return readListing(await response.json())
}

/**
 * Mount the detector. One sweep runs shortly after load, then on an interval;
 * a sweep that finds nothing to change writes nothing at all.
 * @param ctx - plugin context.
 * @param config - raw plugin config.
 */
/**
 * Build the status writer. It deliberately does not depend on a valid config:
 * a plugin whose config was rejected must still leave a trace on disk.
 * @param rawConfig - the raw plugin config, whatever it turned out to be.
 * @returns a writer that merges one patch into the status document.
 */
export function createStatus(rawConfig) {
  const requested = rawConfig !== null && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig.statusFile : undefined
  if (requested === false) return () => {}
  const file = typeof requested === 'string' && requested.length > 0 ? requested : defaultStatusFile()
  return (patch) => {
    try {
      let previous = {}
      try {
        previous = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        previous = {}
      }
      writeFileSync(file, `${JSON.stringify({ ...previous, ...patch, statusFile: file, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    } catch {
      /* a status document is never worth failing a load or a sweep over */
    }
  }
}

export function apply(ctx, config) {
  const status = createStatus(config)
  status({ phase: 'apply', plugin: name, rawConfig: config ?? null, pid: process.pid, node: process.version, execPath: process.execPath })

  const options = normalizeConfig(config)
  const log = (level, message, ...rest) => {
    if (!options.log) return
    const logger = ctx.logger
    if (logger === undefined) return
    logger[level](`api-thinking: ${message}`, ...rest)
  }

  let running = false

  const sweep = async (reason) => {
    if (running) return
    running = true
    // Self-healing: a reload can apply this plugin before hmr is ready.
    ensureWatcher()
    const results = []
    let wrote = false
    let via = null
    let failure
    try {
      const editor = ctx.get('configEditor')
      if (editor === undefined) throw new Error('no config editor is mounted; nothing can be written')
      const entry = editor.entries().find((candidate) => candidate.options.id === options.entryId)
      if (entry === undefined) throw new Error(`profile row "${options.entryId}" is not loaded`)
      const providers = effectiveProviders(editor, options.entryId, entry.options.config?.providers)
      if (providers === null || typeof providers !== 'object') throw new Error(`profile row "${options.entryId}" declares no providers`)

      const next = structuredClone(providers)
      for (const [route, profile] of Object.entries(providers)) {
        if (options.routes.length > 0 && !options.routes.includes(route)) continue
        if (profile === null || typeof profile !== 'object') continue
        const api = typeof profile.api === 'string' ? profile.api : 'openai-completions'
        if (!LISTABLE.has(api)) continue
        if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0) continue
        if (!Array.isArray(profile.models) || profile.models.length === 0) continue

        const result = { route, api, baseURL: profile.baseURL, models: profile.models.length, listed: 0, changes: [], dropped: [], error: null }
        results.push(result)

        let listing
        try {
          listing = await fetchListing(ctx, route, profile, options)
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error)
          log('warn', 'could not read the model listing of route %s: %s', route, result.error)
          continue
        }
        result.listed = listing.length

        const plan = planModels(profile.models, listing, options)
        next[route] = { ...profile, models: plan.models }
        result.changes = plan.changes.map((change) => ({ id: change.id, to: change.to }))
        result.dropped = plan.dropped
        for (const level of plan.dropped) log('warn', 'route %s publishes level "%s", which DSH cannot name as a thinking level', route, level)
        for (const change of plan.changes) {
          log('info', 'route %s model %s -> %s', route, change.id, change.to === null ? '(no selectable levels)' : JSON.stringify(change.to))
        }
      }

      const changed = results.reduce((sum, result) => sum + result.changes.length, 0)
      if (changed > 0) {
        // Model id -> decided value, dropping any id two routes disagree about.
        const desired = new Map()
        const conflicted = new Set()
        for (const result of results) {
          for (const change of result.changes) {
            if (desired.has(change.id) && !sameEfforts(desired.get(change.id) ?? null, change.to ?? null)) conflicted.add(change.id)
            desired.set(change.id, change.to)
          }
        }
        for (const id of conflicted) desired.delete(id)
        if (conflicted.size > 0) log('warn', 'two routes disagree about %s; leaving them alone', [...conflicted].join(', '))

        try {
          await editor.edit(entry, (current) => ({ ...current, providers: next }))
          via = 'config-editor'
          wrote = true
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // A plugin that was hot-reloaded applies inside the HMR transaction
          // that replaced it; that transaction rejects nesting, so every later
          // edit through this service fails the same way. The profile patch is
          // then the only way through — and the very same watcher recomposes it.
          if (!/cannot be nested/i.test(message)) throw error
          const patchPath = editor.documentPath
          if (typeof patchPath !== 'string' || patchPath.length === 0) throw error
          const written = writePatchFile(patchPath, desired, { entryId: options.entryId })
          via = 'patch-file'
          wrote = written.changed
        }
      }
      log('info', 'sweep (%s): %s', reason, changed === 0 ? 'every managed model already matches its endpoint' : `${String(changed)} model(s) updated via ${via}`)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      log('warn', 'sweep (%s) failed: %s', reason, failure)
    } finally {
      running = false
      status({ phase: 'sweep', reason, entryId: options.entryId, wrote, via, routes: results, error: failure ?? null })
    }
  }

  status({
    phase: 'loaded',
    plugin: name,
    entryId: options.entryId,
    routes: options.routes,
    intervalMs: options.intervalMs,
    includeOff: options.includeOff,
    pid: process.pid,
    node: process.version,
    execPath: process.execPath,
  })
  log('info', 'watching row "%s"%s every %dms', options.entryId, options.routes.length > 0 ? ` routes ${options.routes.join(',')}` : ' (all openai-compatible routes)', options.intervalMs)

  ctx.effect(() => {
    const start = options.startDelayMs === 0 ? undefined : setTimeout(() => void sweep('start'), options.startDelayMs)
    const timer = options.intervalMs === 0 ? undefined : setInterval(() => void sweep('interval'), options.intervalMs)
    return () => {
      if (start !== undefined) clearTimeout(start)
      if (timer !== undefined) clearInterval(timer)
    }
  }, 'api-thinking sweeps')

  // React to profile edits instead of waiting for the next interval: the moment
  // a route or model is saved, the levels follow. `hmr` is optional (headless
  // compositions leave it out) and its watcher debounces with awaitWriteFinish.
  // A sweep that writes nothing stops the chain, so this cannot loop.
  // React to profile edits instead of waiting for the next interval: the moment
  // a route or model is saved, the levels follow. `hmr` is optional (headless
  // compositions leave it out) and its watcher debounces with awaitWriteFinish.
  // Registration is retried by every sweep, because a reload can apply this
  // plugin before the hmr service or the profile context is ready.
  let watching = false
  const ensureWatcher = () => {
    if (watching) return true
    const hmr = ctx.get('hmr')
    if (hmr === undefined || typeof hmr.watchConfig !== 'function') return false
    let patchPath
    try {
      const editor = ctx.get('configEditor')
      patchPath = typeof editor?.documentPath === 'string' && editor.documentPath.length > 0 ? editor.documentPath : undefined
    } catch {
      patchPath = undefined
    }
    if (patchPath === undefined) return false
    watching = true
    ctx.effect(() => {
      let cancelled = false
      let dispose
      const release = (value) => {
        if (typeof value === 'function') value()
        else if (value !== null && typeof value === 'object' && typeof value.dispose === 'function') value.dispose()
      }
      hmr.watchConfig(patchPath, () => sweep('config-change')).then(
        (value) => {
          if (cancelled) release(value)
          else dispose = value
        },
        (error) => log('warn', 'could not watch %s: %s', patchPath, error instanceof Error ? error.message : String(error)),
      )
      return () => {
        cancelled = true
        if (dispose !== undefined) release(dispose)
      }
    }, 'api-thinking config watcher')
    status({ phase: 'watching', configWatcher: true, patchPath })
    log('info', 'watching %s for profile edits', patchPath)
    return true
  }

  if (!ensureWatcher()) {
    status({ phase: 'watching', configWatcher: false, note: 'hmr or the profile context was not ready; the next sweep retries' })
    log('info', 'hmr watcher not ready yet; profile edits are picked up by the interval until it is')
  }
}
