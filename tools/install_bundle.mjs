// Install this package as a profile bundle.
//
//   node tools/install_bundle.mjs                      # link this directory in place
//   node tools/install_bundle.mjs --dry-run
//   node tools/install_bundle.mjs --dest <dir> --profile-dir <dir>
//
// Steps: validate the package, optionally copy it, back up the profile manifest
// and lockfile, `pnpm add link:<dest>`, list it in `dsh.profile.bundles`, then
// verify the loader can import it the way it will at runtime.
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, lstatSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { dshHome, packageRoot, profileDir } from './paths.mjs'

const DRY = process.argv.includes('--dry-run')
const value = (key, fallback) => {
  const index = process.argv.indexOf(`--${key}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const SOURCE = resolve(value('source', packageRoot))
const DEST = resolve(value('dest', SOURCE))
const PROFILE = resolve(value('profile-dir', profileDir()))

const stamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
})()

const step = (n, message) => console.log(`\n[${n}] ${message}`)

// ── 1. the package itself ─────────────────────────────────────────────────
step(1, `package ${SOURCE}`)
const sourceManifestPath = join(SOURCE, 'package.json')
if (!existsSync(sourceManifestPath)) throw new Error(`${sourceManifestPath} is missing — run this from the package directory`)
const manifest = JSON.parse(readFileSync(sourceManifestPath, 'utf8'))
if (typeof manifest.name !== 'string' || manifest.name.length === 0) throw new Error('package.json declares no name')
if (manifest.dsh?.bundle?.patch === undefined) throw new Error('package.json declares no dsh.bundle.patch, so it is not a bundle')
if (!existsSync(join(SOURCE, 'lib/index.js'))) throw new Error('lib/index.js is missing')
console.log(`    ${manifest.name}@${manifest.version ?? '0.0.0'}, bundle patch ${manifest.dsh.bundle.patch}`)

// ── 2. copy, when the destination is not the source ───────────────────────
step(2, DEST === SOURCE ? 'install in place (no copy)' : `copy to ${DEST}`)
if (DEST !== SOURCE) {
  if (existsSync(DEST) && readdirSync(DEST).length > 0) {
    const backup = `${DEST}.bak-${stamp}`
    console.log(`    existing install found -> ${backup}`)
    if (!DRY) cpSync(DEST, backup, { recursive: true })
  }
  if (!DRY) {
    mkdirSync(DEST, { recursive: true })
    cpSync(SOURCE, DEST, { recursive: true, force: true })
  }
  console.log(`    ${DRY ? 'would copy' : 'copied'}`)
}

// ── 3. back up the profile manifest and lockfile ──────────────────────────
step(3, `profile ${PROFILE}`)
const profileManifestPath = join(PROFILE, 'package.json')
if (!existsSync(profileManifestPath)) throw new Error(`${profileManifestPath} is missing — is --profile-dir right?`)
const before = readFileSync(profileManifestPath, 'utf8')
for (const file of [profileManifestPath, join(PROFILE, 'pnpm-lock.yaml')]) {
  if (!existsSync(file)) continue
  const backup = `${file}.bak-${stamp}`
  if (!DRY) copyFileSync(file, backup)
  console.log(`    ${file} -> ${backup}`)
}

// ── 4. install the dependency ─────────────────────────────────────────────
step(4, 'install as a profile dependency')
const spec = `link:${DEST}`
const pnpm = (() => {
  if (process.env.API_THINKING_PNPM) return process.env.API_THINKING_PNPM
  const runtimes = join(dshHome(), 'dsh-runtimes')
  if (existsSync(runtimes)) {
    for (const entry of readdirSync(runtimes)) {
      const candidate = join(runtimes, entry, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(candidate)) return candidate
    }
  }
  return 'pnpm'
})()
console.log(`    pnpm: ${pnpm}`)

if (DRY) {
  console.log(`    would run: ${pnpm} add "${spec}" (cwd ${PROFILE})`)
} else {
  const isScript = pnpm.endsWith('.mjs')
  const result = spawnSync(isScript ? process.execPath : pnpm, [...(isScript ? [pnpm] : []), 'add', spec, '--prefer-offline'], {
    cwd: PROFILE,
    stdio: 'inherit',
  })
  if (result.error !== undefined || result.status !== 0) {
    console.log(`    pnpm failed (${result.error?.code ?? `exit ${String(result.status)}`}); falling back to a manifest edit plus a directory junction`)
    const linkPath = join(PROFILE, 'node_modules', manifest.name)
    const pkg = JSON.parse(before)
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [manifest.name]: spec }
    writeFileSync(profileManifestPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    if (existsSync(linkPath)) {
      const stat = lstatSync(linkPath)
      if (stat.isSymbolicLink() || stat.isDirectory()) rmSync(linkPath, { recursive: true, force: true })
    }
    mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
    symlinkSync(DEST, linkPath, 'junction')
    console.log(`    junction ${linkPath} -> ${DEST}`)
  }
}

// ── 5. list it in the manifest ────────────────────────────────────────────
step(5, 'add it to dsh.profile.bundles')
const pkg = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
if (!DRY && pkg.dependencies?.[manifest.name] === undefined) throw new Error(`dependency ${manifest.name} is missing after install`)
const bundles = pkg.dsh?.profile?.bundles
if (!Array.isArray(bundles)) throw new Error('the profile manifest declares no dsh.profile.bundles')
if (bundles.includes(manifest.name)) {
  console.log(`    already listed at index ${String(bundles.indexOf(manifest.name))}`)
} else {
  bundles.push(manifest.name)
  if (!DRY) writeFileSync(profileManifestPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  console.log(`    appended -> [${bundles.join(', ')}]`)
}

// ── 6. verify the way the loader will import it ───────────────────────────
step(6, 'verify resolution from the profile')
const linked = join(PROFILE, 'node_modules', manifest.name)
console.log(`    ${linked} -> ${existsSync(linked) ? realpathSync(linked) : 'MISSING'}`)
console.log(`    relative to the profile: ${relative(PROFILE, DEST)}`)
if (!DRY) {
  const probe = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `const m = await import(${JSON.stringify(manifest.name)}); console.log('import ok:', m.name, 'inject=' + JSON.stringify(m.inject), 'exports=' + Object.keys(m).filter((k) => k !== 'name').length)`],
    { cwd: PROFILE, encoding: 'utf8' },
  )
  if (probe.error !== undefined) console.log(`    could not run the import probe (${probe.error.code ?? probe.error.message}); check it by hand`)
  else {
    console.log(`    ${(probe.stdout ?? '').trim() || `import failed: ${(probe.stderr ?? '').trim()}`}`)
    if (probe.status !== 0) throw new Error('the loader could not import the bundle')
  }
}

console.log(DRY ? '\ndry run: nothing was written' : '\ndone — the profile reloads itself when the bundles list changes')
