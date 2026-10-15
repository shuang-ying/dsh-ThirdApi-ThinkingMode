// Shared resolution for the maintenance tools, so they work on any machine.
//
// Everything is derived from the DSH home and overridable by environment:
//   DSH_HOME / DSH_PROFILE              which profile to read
//   API_THINKING_PROFILE                the profile patch file itself
//   API_THINKING_PROFILE_DIR            the profile directory
//   API_THINKING_BASE_URL + _API_KEY    the gateway to compare against
//   API_THINKING_GATEWAY_CONFIG         a gateway config.json ({ listen, api_key })
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** This package's root directory (the parent of tools/). */
export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** The harness home, `~/.dsh` unless DSH_HOME says otherwise. */
export function dshHome() {
  return process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh')
}

/** The profile directory these tools read and write. */
export function profileDir() {
  if (process.env.API_THINKING_PROFILE_DIR) return process.env.API_THINKING_PROFILE_DIR
  return join(dshHome(), 'profiles', process.env.DSH_PROFILE ? process.env.DSH_PROFILE : 'desktop')
}

/** The profile patch file (the layer the detector writes into). */
export function profilePatch() {
  return process.env.API_THINKING_PROFILE ? process.env.API_THINKING_PROFILE : join(profileDir(), 'cordis.patch.yml')
}

/**
 * Load js-yaml from the harness installation instead of a hardcoded path.
 * @returns the js-yaml module.
 */
export function loadYaml() {
  const require = createRequire(join(profileDir(), 'package.json'))
  try {
    return require('js-yaml')
  } catch (error) {
    throw new Error(
      `js-yaml could not be resolved from ${profileDir()} (${error?.code ?? error?.message}). ` +
        'Run these tools on a machine with a DSH profile, or point API_THINKING_PROFILE_DIR at one.',
    )
  }
}

/**
 * Read the `providers` of one profile row, tolerating `!!js` tags.
 * @param entryId - the row to read, `llm-pi-ai` by default.
 * @returns the patch path and the composed provider map in the patch.
 */
export function readProfileProviders(entryId = 'llm-pi-ai') {
  const yaml = loadYaml()
  const patch = profilePatch()
  const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: (data) => data })
  const document = yaml.load(readFileSync(patch, 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([jsType]) })
  const entry = Array.isArray(document) ? document.find((row) => row?.id === entryId) : undefined
  if (entry === undefined) throw new Error(`row "${entryId}" not found in ${patch}`)
  return { patch, providers: entry.config?.providers ?? {} }
}

/**
 * Resolve the gateway to compare against, from the environment.
 * @returns the base URL (no trailing slash) and the API key, if any.
 */
export function gateway() {
  if (process.env.API_THINKING_BASE_URL) {
    const base = process.env.API_THINKING_BASE_URL.replace(/\/+$/, '')
    return { baseURL: /\/v1$/.test(base) ? base : `${base}/v1`, apiKey: process.env.API_THINKING_API_KEY }
  }
  const file = process.env.API_THINKING_GATEWAY_CONFIG
  if (!file) {
    throw new Error(
      'no gateway configured: set API_THINKING_BASE_URL (and API_THINKING_API_KEY), ' +
        'or API_THINKING_GATEWAY_CONFIG to a config.json carrying { listen, api_key }',
    )
  }
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const listen = typeof raw.listen === 'string' && raw.listen.length > 0 ? raw.listen : ':7863'
  return { baseURL: `http://${listen.startsWith(':') ? `127.0.0.1${listen}` : listen}/v1`, apiKey: raw.api_key }
}

/**
 * Fetch the gateway's raw model listing.
 * @returns the parsed body.
 */
export async function fetchGatewayListing() {
  const { baseURL, apiKey } = gateway()
  const response = await fetch(`${baseURL}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  })
  if (!response.ok) throw new Error(`GET ${baseURL}/models -> ${response.status}`)
  return response.json()
}
