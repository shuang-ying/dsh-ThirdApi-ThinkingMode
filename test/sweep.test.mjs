// Unit tests for the pure half of api_thinking, plus an optional cross-check
// against a real gateway listing.
//
//   node --test test/
//   API_THINKING_CATALOG=/path/to/models.catalog.json node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  LEVELS,
  normalizeConfig,
  readCapability,
  readListing,
  decideEfforts,
  sameEfforts,
  unusableLevels,
  planModels,
  defaultStatusFile,
  effectiveProviders,
  planPatchEdits,
  writePatchFile,
} from '../lib/index.js'

test('normalizeConfig applies defaults and rejects nonsense', () => {
  assert.deepEqual(normalizeConfig(undefined), {
    entryId: 'llm-pi-ai',
    routes: [],
    intervalMs: 120000,
    startDelayMs: 3000,
    timeoutMs: 15000,
    includeOff: false,
    fixedEffortAsLevel: true,
    log: true,
    statusFile: '',
  })
  assert.equal(normalizeConfig({ routes: ['a'], includeOff: true }).includeOff, true)
  assert.equal(normalizeConfig({ intervalMs: 0 }).intervalMs, 0)
  assert.equal(normalizeConfig({ fixedEffortAsLevel: false }).fixedEffortAsLevel, false)
  assert.equal(normalizeConfig({ statusFile: false }).statusFile, false)
  assert.equal(normalizeConfig({ statusFile: 'D:/tmp/x.json' }).statusFile, 'D:/tmp/x.json')
  assert.throws(() => normalizeConfig([]), /config must be a map/)
  assert.throws(() => normalizeConfig({ entryId: '' }), /entryId/)
  assert.throws(() => normalizeConfig({ routes: 'a' }), /routes/)
  assert.throws(() => normalizeConfig({ intervalMs: -1 }), /intervalMs/)
  assert.throws(() => normalizeConfig({ includeOff: 'yes' }), /includeOff/)
  assert.throws(() => normalizeConfig({ fixedEffortAsLevel: 'yes' }), /fixedEffortAsLevel/)
  assert.throws(() => normalizeConfig({ statusFile: 5 }), /statusFile/)
})

test('effectiveProviders reads the composed layers, not the stale snapshot', () => {
  const fallback = { stale: { api: 'openai-completions' } }
  const row = {
    entry: { options: { id: 'llm-pi-ai' } },
    inherited: { providers: { base: { api: 'openai-completions' }, shared: { baseURL: 'http://old' } } },
    override: { providers: { shared: { baseURL: 'http://new' }, fresh: { api: 'openai-completions' } } },
  }
  const merged = effectiveProviders({ configuration: () => [row] }, 'llm-pi-ai', fallback)
  // a route the user layer defines replaces the inherited one wholesale
  assert.deepEqual(Object.keys(merged).sort(), ['base', 'fresh', 'shared'])
  assert.deepEqual(merged.shared, { baseURL: 'http://new' })

  // anything unusable falls back to the instantiated config
  assert.equal(effectiveProviders({}, 'llm-pi-ai', fallback), fallback)
  assert.equal(effectiveProviders({ configuration: () => { throw new Error('no profile context') } }, 'llm-pi-ai', fallback), fallback)
  assert.equal(effectiveProviders({ configuration: () => 'nope' }, 'llm-pi-ai', fallback), fallback)
  assert.equal(effectiveProviders({ configuration: () => [{ entry: { options: { id: 'other' } } }] }, 'llm-pi-ai', fallback), fallback)
  assert.equal(effectiveProviders({ configuration: () => [{ entry: { options: { id: 'llm-pi-ai' } } }] }, 'llm-pi-ai', fallback), fallback)
})

test('defaultStatusFile lands in the harness home', () => {  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = 'C:/tmp/dsh-home'
    assert.equal(defaultStatusFile(), 'C:\\tmp\\dsh-home\\api-thinking.status.json')
    delete process.env.DSH_HOME
    assert.match(defaultStatusFile(), /api-thinking\.status\.json$/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('readCapability reads the gateway fields it knows', () => {
  assert.deepEqual(
    readCapability({ reasoning_supported_efforts: ['low', 'high', 'max'], can_disable_thinking: true, supports_reasoning: true }),
    { efforts: ['low', 'high', 'max'], canDisable: true, supports: true },
  )
  assert.deepEqual(readCapability({ supported_efforts: ['medium'] }), { efforts: ['medium'], canDisable: false, supports: undefined })
  assert.deepEqual(readCapability({ supports_reasoning: false }), { efforts: [], canDisable: false, supports: false })
  // a pinned effort with no selectable set is still a capability record
  assert.deepEqual(readCapability({ reasoning_effort: 'high', supports_reasoning: true }), {
    efforts: [],
    canDisable: false,
    supports: true,
    fixedEffort: 'high',
  })
  // an entry that says nothing about reasoning is not a capability record
  assert.equal(readCapability({ id: 'x', context_length: 1000 }), undefined)
  assert.equal(readCapability(undefined), undefined)
})

test('decideEfforts exposes a pinned effort as the one level the model runs at', () => {
  const pinned = { efforts: [], canDisable: false, supports: true, fixedEffort: 'high' }
  assert.deepEqual(decideEfforts(pinned), { high: 'high' })
  assert.equal(decideEfforts(pinned, { fixedEffortAsLevel: false }), null)
  assert.deepEqual(decideEfforts({ ...pinned, canDisable: true }, { includeOff: true }), { off: 'off', high: 'high' })
  // a pinned value DSH cannot name is not a level
  assert.equal(decideEfforts({ ...pinned, fixedEffort: 'ultra' }), null)
  assert.deepEqual(unusableLevels({ ...pinned, fixedEffort: 'ultra' }), ['ultra'])
})

test('decideEfforts honours the published set and never invents one', () => {
  assert.deepEqual(decideEfforts({ efforts: ['high', 'low', 'max'], canDisable: false }), { low: 'low', high: 'high', max: 'max' })
  assert.deepEqual(decideEfforts({ efforts: ['high', 'low'], canDisable: true }, { includeOff: true }), { off: 'off', low: 'low', high: 'high' })
  // off is opt-in: the pi-ai adapter would send it as the no-selection default
  assert.deepEqual(decideEfforts({ efforts: ['high'], canDisable: true }), { high: 'high' })
  assert.equal(decideEfforts({ efforts: [], supports: false }), false)
  assert.equal(decideEfforts({ efforts: [], supports: true }), null)
  assert.equal(decideEfforts({ efforts: [], supports: undefined }), null)
  assert.equal(decideEfforts(undefined), undefined)
  // a set DSH cannot name is not a set
  assert.equal(decideEfforts({ efforts: ['ultra'], canDisable: false }), undefined)
})

test('unusableLevels names what DSH cannot express', () => {
  assert.deepEqual(unusableLevels({ efforts: ['low', 'ultra', 'none'] }), ['ultra', 'none'])
  assert.deepEqual(unusableLevels({ efforts: LEVELS.slice() }), [])
  assert.deepEqual(unusableLevels(undefined), [])
})

test('sameEfforts ignores key order but not content', () => {
  assert.equal(sameEfforts({ low: 'low', high: 'high' }, { high: 'high', low: 'low' }), true)
  assert.equal(sameEfforts({ low: 'low' }, { low: 'low', high: 'high' }), false)
  assert.equal(sameEfforts({ max: 'max' }, { max: 'ultra' }), false)
  assert.equal(sameEfforts(false, false), true)
  assert.equal(sameEfforts(undefined, false), false)
  assert.equal(sameEfforts(undefined, undefined), true)
  assert.equal(sameEfforts(false, null), false)
})

test('readListing accepts data arrays and models maps', () => {
  assert.deepEqual(readListing({ data: [{ id: 'a' }, { id: 'b' }] }).map((x) => x.id), ['a', 'b'])
  assert.deepEqual(readListing({ models: [{ id: 'a' }] }).map((x) => x.id), ['a'])
  assert.deepEqual(readListing({ models: { a: { name: 'A' }, b: {} } }).map((x) => x.id), ['a', 'b'])
  assert.deepEqual(readListing({}).length, 0)
  assert.deepEqual(readListing({ data: [{ name: 'no-id' }, null, 'nope'] }).length, 0)
})

test('planModels leaves unlisted models alone and is idempotent', () => {
  const models = [
    { id: 'known', name: 'Known', contextWindow: 1, maxTokens: 1 },
    { id: 'absent-from-endpoint', name: 'Absent', contextWindow: 1, maxTokens: 1, reasoningEfforts: { high: 'high' } },
    { id: 'pinned-nonreasoning', name: 'Pinned', contextWindow: 1, maxTokens: 1, reasoningEfforts: false },
    { id: 'listed-but-silent', name: 'Silent', contextWindow: 1, maxTokens: 1, reasoningEfforts: { low: 'low', high: 'high' } },
  ]
  const listing = readListing({
    data: [
      { id: 'known', reasoning_supported_efforts: ['low', 'high', 'max'] },
      { id: 'pinned-nonreasoning', supports_reasoning: false },
      // a gateway that publishes context and nothing about reasoning must not
      // cost the user their hand-written levels
      { id: 'listed-but-silent', context_length: 4096, max_output_tokens: 512 },
    ],
  })

  const first = planModels(models, listing)
  assert.deepEqual(first.models[0].reasoningEfforts, { low: 'low', high: 'high', max: 'max' })
  assert.deepEqual(first.changes.map((c) => c.id), ['known'])
  // the model the endpoint never mentions keeps its hand-written value
  assert.deepEqual(first.models[1].reasoningEfforts, { high: 'high' })
  assert.equal(first.models[2].reasoningEfforts, false)
  assert.deepEqual(first.models[3].reasoningEfforts, { low: 'low', high: 'high' })
  // inputs are not mutated
  assert.equal(Object.hasOwn(models[0], 'reasoningEfforts'), false)

  const second = planModels(first.models, listing)
  assert.deepEqual(second.changes, [])
  assert.deepEqual(second.models, first.models)
})

test('planModels removes the key when the endpoint publishes no selectable set', () => {
  const models = [{ id: 'fixed', name: 'Fixed', reasoningEfforts: false }]
  const listing = readListing({ data: [{ id: 'fixed', reasoning_effort: 'high', supports_reasoning: true }] })
  const plan = planModels(models, listing, { fixedEffortAsLevel: false })
  assert.equal(Object.hasOwn(plan.models[0], 'reasoningEfforts'), false)
  assert.deepEqual(plan.changes, [{ id: 'fixed', from: false, to: null }])
  // already absent -> no write
  assert.deepEqual(planModels(plan.models, listing, { fixedEffortAsLevel: false }).changes, [])
  // with the default, the same model instead shows the pinned effort
  const pinned = planModels(models, listing)
  assert.deepEqual(pinned.models[0].reasoningEfforts, { high: 'high' })
  assert.deepEqual(pinned.changes, [{ id: 'fixed', from: false, to: { high: 'high' } }])
})

test('planModels reports levels DSH cannot name', () => {
  const listing = readListing({ data: [{ id: 'odd', reasoning_supported_efforts: ['low', 'ultra'] }] })
  const plan = planModels([{ id: 'odd' }], listing)
  assert.deepEqual(plan.dropped, ['ultra'])
  assert.deepEqual(plan.models[0].reasoningEfforts, { low: 'low' })
})

const FIXTURE = `- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: system
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      localcn:
        apiKeyEnv: LOCALCN_API_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:7863/v1
        models:
          # a comment that must survive untouched
          - id: cn:a
            name: A
            contextWindow: 1000
            maxTokens: 100
          - id: cn:b
            name: B
            maxTokens: 100
            reasoningEfforts:
              off:
              low: low
              high: high
          - id: cn:c
            name: C
            maxTokens: 100
            reasoningEfforts: false
      localglobal:
        api: openai-completions
        baseURL: http://127.0.0.1:7863/v1
        models:
          - id: global:a
            name: GA
            maxTokens: 100
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: localcn
    reasoningEffort: max
`

test('planPatchEdits inserts, replaces and removes only what it owns', () => {
  const desired = new Map([
    ['cn:a', { low: 'low', high: 'high', max: 'max' }],
    ['cn:b', { high: 'high' }],
    ['cn:c', null],
    ['global:a', false],
  ])
  const planned = planPatchEdits(FIXTURE.split('\n'), desired)
  assert.equal(planned.changed, true)
  const text = planned.lines.join('\n')

  // the untouched model gains a block right after its last field
  assert.match(text, /- id: cn:a\n\s+name: A\n\s+contextWindow: 1000\n\s+maxTokens: 100\n\s+reasoningEfforts:\n\s+low: low\n\s+high: high\n\s+max: max\n/)
  // the stale block is replaced, and "off" is gone with it
  assert.match(text, /- id: cn:b\n\s+name: B\n\s+maxTokens: 100\n\s+reasoningEfforts:\n\s+high: high\n/)
  assert.equal(/off:/.test(text), false)
  // a published-but-empty set drops the key entirely
  assert.match(text, /- id: cn:c\n\s+name: C\n\s+maxTokens: 100\n\s+localglobal:\n/)
  // an explicitly non-reasoning model is pinned
  assert.match(text, /- id: global:a\n\s+name: GA\n\s+maxTokens: 100\n\s+reasoningEfforts: false\n/)
  // everything else is byte-identical
  assert.match(text, /# a comment that must survive untouched/)
  assert.match(text, /- id: ui-theme\n\s+name: "@deepseek-ai\/dsh-client-ui-theme"\n\s+config:\n\s+preference: system\n/)
  assert.match(text, /- id: agent-default-model\n\s+name: "@deepseek-ai\/dsh-agent-default-model"\n\s+config:\n\s+provider: localcn\n\s+reasoningEffort: max\n$/)
  assert.match(text, /\n\s+localglobal:\n\s+api: openai-completions\n/)

  // a second pass has nothing left to do
  const again = planPatchEdits(planned.lines, desired)
  assert.equal(again.changed, false)
  assert.deepEqual(again.lines, planned.lines)

  // ids the file does not carry, and rows that are not the configured entry, are ignored
  assert.equal(planPatchEdits(FIXTURE.split('\n'), new Map([['cn:zzz', false]])).changed, false)
  assert.equal(planPatchEdits(FIXTURE.split('\n'), new Map([['cn:a', null]])).changed, false)
  const otherRow = planPatchEdits(FIXTURE.split('\n'), desired, { entryId: 'ui-theme' })
  assert.equal(otherRow.changed, false)
})

test('writePatchFile touches the file only when something moved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'api-thinking-'))
  const file = join(dir, 'cordis.patch.yml')
  writeFileSync(file, FIXTURE, 'utf8')

  const first = writePatchFile(file, new Map([['cn:a', { low: 'low' }]]))
  assert.equal(first.changed, true)
  assert.match(readFileSync(file, 'utf8'), /- id: cn:a\n\s+name: A\n\s+contextWindow: 1000\n\s+maxTokens: 100\n\s+reasoningEfforts:\n\s+low: low\n/)
  const second = writePatchFile(file, new Map([['cn:a', { low: 'low' }]]))
  assert.equal(second.changed, false)
  rmSync(dir, { recursive: true, force: true })
})

// ── optional: cross-check against a real gateway listing ──────────────────
const CATALOG = process.env.API_THINKING_CATALOG ?? fileURLToPath(new URL('../tools/models.catalog.json', import.meta.url))

test('detected levels match a real gateway catalog', { skip: !existsSync(CATALOG) }, () => {
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
  const listing = readListing(catalog)
  assert.ok(listing.length > 0, 'catalog should carry models')

  // start from the same placeholder the hand-written patch used, so the run has
  // to correct, remove and keep entries all at once
  const models = listing.map((item) => ({ id: item.id, reasoningEfforts: { off: null, low: 'low', high: 'high' } }))
  const plan = planModels(models, listing)
  const decided = new Map(plan.models.map((m) => [m.id, m.reasoningEfforts]))
  const has = (id) => Object.hasOwn(plan.models.find((m) => m.id === id), 'reasoningEfforts')

  assert.deepEqual(decided.get('cn:deepseek-v4.1-flash'), { low: 'low', high: 'high', max: 'max' })
  assert.deepEqual(decided.get('cn:deepseek-v4-pro'), { low: 'low', high: 'high', xhigh: 'xhigh' })
  assert.deepEqual(decided.get('cn:minimax-m3'), { medium: 'medium' })
  assert.deepEqual(decided.get('global:gpt-5.6-terra'), { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' })
  // a pinned effort with no selectable set shows that one level
  assert.deepEqual(decided.get('cn:auto'), { high: 'high' })
  assert.deepEqual(decided.get('global:deepseek-v4.1-flash-sg'), { high: 'high' })
  // an endpoint that says nothing about reasoning at all is left untouched, so
  // a silent gateway can never strip hand-written levels
  assert.equal(has('global:o4-mini'), true)
  assert.deepEqual(plan.dropped, [])
})
