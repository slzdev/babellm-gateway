#!/usr/bin/env node
// Regenerates src/lib/catalog/seed/models.json — the offline floor for a
// fresh install that has never reached the network.
//
//   node scripts/refresh-seed.mjs
//
// The output is generated. Do not hand-edit it; re-run this and review the
// diff. A large diff is expected and normal.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const SOURCE = process.env.REGISTRY_URL ?? 'https://models.dev/api.json'
const OUT = path.join(import.meta.dirname, '..', 'src', 'lib', 'catalog', 'seed', 'models.json')

// Exactly the keys projectModelsDev() reads. Anything else is dead weight.
const MODEL_FIELDS = ['id', 'family', 'temperature', 'tool_call', 'modalities', 'limit', 'cost']

function pick(source, fields) {
  const out = {}
  for (const field of fields) if (source[field] !== undefined) out[field] = source[field]
  return out
}

const response = await fetch(SOURCE, { headers: { accept: 'application/json' } })
if (!response.ok) {
  console.error(`Failed to fetch ${SOURCE}: ${response.status} ${response.statusText}`)
  process.exit(1)
}

const doc = await response.json()
const trimmed = {}
let providers = 0
let models = 0

for (const [slug, provider] of Object.entries(doc)) {
  if (!provider || typeof provider !== 'object' || !provider.models) continue
  const entries = {}
  for (const [id, model] of Object.entries(provider.models)) {
    entries[id] = pick(model, MODEL_FIELDS)
    models += 1
  }
  trimmed[slug] = { id: provider.id ?? slug, name: provider.name ?? slug, models: entries }
  providers += 1
}

if (providers < 100 || models === 0) {
  console.error(`Refusing to write a degenerate seed (${providers} providers / ${models} models).`)
  process.exit(1)
}

await mkdir(path.dirname(OUT), { recursive: true })
await writeFile(OUT, `${JSON.stringify(trimmed, null, 0)}\n`)
console.log(`Wrote ${providers} providers / ${models} models to ${path.relative(process.cwd(), OUT)}`)
