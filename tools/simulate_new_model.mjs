// Simulate a model that was just added to the profile without capabilities:
// strip one model's reasoningEfforts block from the live profile patch, exactly
// the way a new row looks before the detector has seen it. Watch the plugin put
// it back within seconds.
//
//   node tools/simulate_new_model.mjs cn:glm-5.3
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { profilePatch } from './paths.mjs'

const PROFILE = profilePatch()
const id = process.argv[2]
if (id === undefined) throw new Error('usage: node tools/simulate_new_model.mjs <model-id>')

const raw = readFileSync(PROFILE, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const idLine = lines.findIndex((line) => line.trim() === `- id: ${id}`)
if (idLine === -1) throw new Error(`model ${id} not found`)
const idIndent = lines[idLine].search(/\S/)
const fieldIndent = ' '.repeat(idIndent + 2)

// the model's own field region ends at the next `- id:` or at a shallower line
let end = idLine + 1
while (end < lines.length) {
  const line = lines[end]
  if (/^\s*- id: /.test(line)) break
  if (line.trim() !== '' && line.search(/\S/) <= idIndent) break
  end += 1
}

const out = []
let removed = 0
for (let i = 0; i < lines.length; i += 1) {
  if (i === idLine) {
    // drop the reasoningEfforts header plus its deeper-indented children
    for (let k = idLine + 1; k < end; k += 1) {
      if (!lines[k].startsWith(`${fieldIndent}reasoningEfforts:`)) continue
      let e = k + 1
      while (e < end && lines[e].trim() !== '' && lines[e].search(/\S/) > fieldIndent.length) e += 1
      removed = e - k
      lines.splice(k, e - k)
      break
    }
  }
}
if (removed === 0) throw new Error(`model ${id} carries no reasoningEfforts block to remove`)

copyFileSync(PROFILE, `${PROFILE}.bak-simulate`)
writeFileSync(PROFILE, lines.join(eol), 'utf8')
console.log(`removed ${String(removed)} line(s) of reasoningEfforts from ${id}`)
console.log('now wait for the detector: a config-triggered reload or the next interval sweep')
