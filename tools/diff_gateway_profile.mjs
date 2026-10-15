// "Why does my new API not show thinking levels?" — in one command.
//
// Compares the gateway's live model listing with the profile's configured
// models, per route, and says for every gap whose job it is to close it:
//   * only at the gateway -> nothing in DSH can select it yet; add it through
//                            the Models page (the detector only manages levels
//                            of models that are already configured)
//   * only in the profile -> the gateway no longer advertises it
//   * both, but the gateway publishes no selectable set -> the detector
//                            deliberately writes nothing (or just the pinned level)
//
//   node tools/diff_gateway_profile.mjs
import { readListing, readCapability, decideEfforts, LEVELS } from '../lib/index.js'
import { fetchGatewayListing, readProfileProviders } from './paths.mjs'

const ENTRY = 'llm-pi-ai'

const { providers } = readProfileProviders(ENTRY)
const listing = readListing(await fetchGatewayListing())
const byId = new Map(listing.map((item) => [item.id, item.raw]))
console.log(`gateway: ${String(listing.length)} models advertised`)

const configured = new Set()
let issues = 0
for (const [route, profile] of Object.entries(providers)) {
  const models = Array.isArray(profile.models) ? profile.models : []
  console.log(`\nroute ${route}  api=${profile.api ?? 'openai-completions'}  baseURL=${profile.baseURL ?? '-'}  models=${String(models.length)}`)
  for (const model of models) {
    configured.add(model.id)
    const capability = readCapability(byId.get(model.id))
    const decided = decideEfforts(capability)
    const declared = model.reasoningEfforts
    let verdict
    if (capability === undefined) {
      // Silence is handled by design, not a defect: only a published capability
      // the profile has not applied yet is something to act on.
      verdict = byId.has(model.id)
        ? 'gateway lists it but says nothing about reasoning -> left as-is (by design)'
        : 'gateway does NOT list this model -> left as-is'
    } else if (decided === null) {
      verdict = 'gateway publishes no selectable set -> key stays absent (by design)'
    } else if (decided === false) {
      verdict = declared === false ? 'non-reasoning, pinned false OK' : 'should be pinned false'
      if (declared !== false) issues += 1
    } else {
      const levels = Object.keys(decided)
      verdict = declared === undefined ? `MISSING LEVELS ${levels.join(',')}` : `levels ${levels.join(',')} OK`
      if (declared === undefined) issues += 1
    }
    console.log(`  ${model.id.padEnd(32)} ${verdict}`)
  }
}

const onlyGateway = listing.filter((item) => !configured.has(item.id))
console.log(`\nmodels the gateway advertises but no route configures: ${String(onlyGateway.length)}`)
for (const item of onlyGateway) {
  const decided = decideEfforts(readCapability(item.raw))
  const levels = decided === null || decided === false || decided === undefined ? '(none published)' : Object.keys(decided).join(',')
  console.log(`  ${item.id.padEnd(32)} levels the detector would write: ${levels}`)
}
if (onlyGateway.length > 0) {
  console.log('\n-> the detector only manages models that are already configured; add these through')
  console.log('   the Models page (fetch available models -> add selected) and the levels follow.')
}
console.log(`\nlevel names in play: ${LEVELS.join(', ')}`)
console.log(issues === 0 ? 'no drift requiring action' : `${String(issues)} model(s) need attention`)
