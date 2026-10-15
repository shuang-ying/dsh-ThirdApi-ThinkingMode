// Dump the gateway's raw model listing next to this script, as a fixture for the
// optional cross-check in test/sweep.test.mjs.
//
//   node tools/fetch_catalog.mjs
//
// The API key comes from the environment (see paths.mjs) and is never printed.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fetchGatewayListing } from './paths.mjs'

const OUT = fileURLToPath(new URL('./models.catalog.json', import.meta.url))

const body = await fetchGatewayListing()
writeFileSync(OUT, `${JSON.stringify(body, null, 2)}\n`, 'utf8')

const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : []
console.log(`models: ${String(list.length)}  (saved ${OUT})`)

const keys = new Map()
for (const model of list) for (const key of Object.keys(model)) keys.set(key, (keys.get(key) ?? 0) + 1)
console.log('\nkeys present across all entries:')
for (const [key, count] of [...keys].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(4)}  ${key}`)

console.log('\nreasoning-ish fields, first 8 entries:')
for (const model of list.slice(0, 8)) {
  const picked = Object.fromEntries(Object.entries(model).filter(([key]) => /reason|effort|thinking|context|max|^id$|name/i.test(key)))
  console.log(' ', JSON.stringify(picked))
}
