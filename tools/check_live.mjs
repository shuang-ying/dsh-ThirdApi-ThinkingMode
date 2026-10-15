// End-to-end check: does the live profile match what the gateway publishes,
// judged by the plugin's own rules? Zero planned changes means the detector has
// nothing left to do, which is what a healthy steady state looks like.
//
//   node tools/check_live.mjs
//
// Reads the profile patch and the gateway from the environment (see paths.mjs).
import { planModels, readListing, LEVELS } from '../lib/index.js'
import { fetchGatewayListing, profilePatch, readProfileProviders } from './paths.mjs'

const ENTRY = 'llm-pi-ai'

const { patch, providers } = readProfileProviders(ENTRY)
const listing = readListing(await fetchGatewayListing())
console.log(`profile ${patch}`)
console.log(`gateway: ${String(listing.length)} models advertised`)

let total = 0
let drift = 0
for (const [route, profile] of Object.entries(providers)) {
  const models = Array.isArray(profile.models) ? profile.models : []
  const plan = planModels(models, listing)
  total += plan.models.length
  drift += plan.changes.length
  const withLevels = plan.models.filter((m) => m.reasoningEfforts !== undefined && m.reasoningEfforts !== false).length
  const pinnedOff = plan.models.filter((m) => m.reasoningEfforts === false).length
  const silent = plan.models.filter((m) => !Object.hasOwn(m, 'reasoningEfforts')).length
  console.log(`${route}: ${String(plan.models.length)} models — ${String(withLevels)} with levels, ${String(pinnedOff)} false, ${String(silent)} untouched, drift ${String(plan.changes.length)}`)
  for (const change of plan.changes) {
    console.log(`  DRIFT ${change.id}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}`)
  }
}

const tally = new Map()
for (const profile of Object.values(providers)) {
  for (const model of profile.models ?? []) {
    const eff = model.reasoningEfforts
    const key = eff === false ? 'false' : eff === undefined ? '(absent)' : Object.keys(eff).join(',')
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
}
console.log('\nlevel sets in the live profile:')
for (const [key, count] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(3)}  ${key}`)
console.log(`\nlevels named anywhere: ${LEVELS.filter((level) => [...tally.keys()].some((key) => key.split(',').includes(level))).join(', ')}`)
console.log(`models: ${String(total)}, drift: ${String(drift)}`)
process.exit(drift === 0 ? 0 : 1)
