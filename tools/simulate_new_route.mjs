// Simulate "I just configured a new API" and "I deleted it", against the live
// profile patch, to watch the detector's lifecycle end to end.
//
//   node tools/simulate_new_route.mjs add probe cn:glm-5.3 cn:glm-5.2
//   node tools/simulate_new_route.mjs remove probe
//
// The added route carries models WITHOUT reasoningEfforts — exactly what the
// Models page writes after endpoint discovery, which normalises only id, name,
// context window and max output tokens. Endpoint and credential reference are
// copied from an existing route unless --base-url / --key-env say otherwise, and
// the sizes come from the gateway's own listing.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { fetchGatewayListing, profilePatch, readProfileProviders } from './paths.mjs'

const PROFILE = profilePatch()
const action = process.argv[2]
const name = process.argv[3]
const rest = process.argv.slice(4)
const flag = (key, fallback) => {
  const index = rest.indexOf(`--${key}`)
  return index === -1 ? fallback : rest[index + 1]
}
const modelIds = rest.filter((value, index) => !value.startsWith('--') && !(index > 0 && rest[index - 1].startsWith('--')))

if (action !== 'add' && action !== 'remove') throw new Error('usage: node tools/simulate_new_route.mjs add|remove <route> [model-id...]')
if (name === undefined || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) throw new Error('route name must match the settings route pattern (lower-case, hyphenated)')

const raw = readFileSync(PROFILE, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const rowIndex = lines.findIndex((line) => line.trim() === '- id: llm-pi-ai')
if (rowIndex === -1) throw new Error(`llm-pi-ai row not found in ${PROFILE}`)
let rowEnd = lines.findIndex((line, index) => index > rowIndex && /^- id: /.test(line))
if (rowEnd === -1) rowEnd = lines.length

const routeLine = `${' '.repeat(6)}${name}:`
const existing = lines.findIndex((line, index) => index > rowIndex && index < rowEnd && line === routeLine)

if (action === 'add') {
  if (existing !== -1) throw new Error(`route ${name} already exists at line ${String(existing + 1)}`)
  if (modelIds.length === 0) throw new Error('name at least one model id to put in the new route')
  const providersIndex = lines.findIndex((line, index) => index > rowIndex && index < rowEnd && line === '    providers:')
  if (providersIndex === -1) throw new Error('providers: not found inside the llm-pi-ai row')

  const { providers } = readProfileProviders()
  const donor = Object.values(providers).find((profile) => typeof profile?.baseURL === 'string')
  const baseURL = flag('base-url', donor?.baseURL)
  const apiKeyEnv = flag('key-env', donor?.apiKeyEnv)
  if (baseURL === undefined || apiKeyEnv === undefined) {
    throw new Error('no existing route to copy from; pass --base-url and --key-env')
  }

  const listing = (await fetchGatewayListing()).data ?? []
  const byId = new Map(listing.map((model) => [model.id, model]))
  const block = [routeLine, `        apiKeyEnv: ${apiKeyEnv}`, '        api: openai-completions', `        baseURL: ${baseURL}`, '        models:']
  for (const id of modelIds) {
    const found = byId.get(id)
    if (found === undefined) throw new Error(`the gateway does not advertise ${id}`)
    block.push(`          - id: ${id}`)
    block.push(`            name: ${found.name ?? id}`)
    block.push(`            contextWindow: ${found.context_length ?? found.contextWindow ?? 128000}`)
    block.push(`            maxTokens: ${found.max_output_tokens ?? found.maxTokens ?? 32000}`)
  }
  lines.splice(providersIndex + 1, 0, ...block)
  copyFileSync(PROFILE, `${PROFILE}.bak-route`)
  writeFileSync(PROFILE, lines.join(eol), 'utf8')
  console.log(`added route ${name} with ${String(modelIds.length)} model(s) and no reasoningEfforts`)
  console.log('watch the detector: a config-triggered sweep lands within seconds')
} else {
  if (existing === -1) throw new Error(`route ${name} not found`)
  const indent = lines[existing].search(/\S/)
  let end = existing + 1
  while (end < lines.length) {
    const line = lines[end]
    if (line.trim() !== '' && line.search(/\S/) <= indent) break
    end += 1
  }
  lines.splice(existing, end - existing)
  copyFileSync(PROFILE, `${PROFILE}.bak-route`)
  writeFileSync(PROFILE, lines.join(eol), 'utf8')
  console.log(`removed route ${name} (${String(end - existing)} lines)`)
}
