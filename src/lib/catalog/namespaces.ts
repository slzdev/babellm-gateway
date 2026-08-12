import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { loadSeedProviders } from './seed'
import type { RegistryNamespace } from './types'

/**
 * Slugs the live registry has actually seen. Read with SQL rather than by
 * pulling `payload` into Node: the projected document is ~1.6 MB and only the
 * ~180 short slugs inside it are wanted.
 *
 * The LIKE guard is load-bearing. split_part returns the whole string when the
 * delimiter is absent, so a malformed key would otherwise come back as a
 * namespace of its own.
 */
async function queryCachedSlugs(): Promise<string[]> {
  const result = await db.execute<{ slug: string }>(sql`
    SELECT DISTINCT split_part(k, '/', 1) AS slug
    FROM registry_cache, jsonb_object_keys(payload) k
    WHERE k LIKE '%/%'
  `)

  return result.rows.map((row) => row.slug)
}

/**
 * Every namespace the provider picker offers: whatever the live cache has seen,
 * unioned with the vendored snapshot. The snapshot is the only source of
 * display names — the cached payload is the projected index, which keeps
 * `slug/modelId` keys and nothing else — so a slug only the cache knows comes
 * back nameless.
 *
 * Every row is read rather than only the active registry URL's: this is a list
 * of suggestions, where being generous beats being precise, and a free-form
 * value is accepted anyway.
 *
 * Never throws. `/providers` has to render even if this query does not, so a
 * failure degrades to the snapshot alone.
 */
export async function listRegistryNamespaces(
  opts: { queryImpl?: () => Promise<string[]> } = {},
): Promise<RegistryNamespace[]> {
  const byslug = new Map<string, string | null>()
  for (const { slug, name } of loadSeedProviders()) byslug.set(slug, name)

  try {
    for (const slug of await (opts.queryImpl ?? queryCachedSlugs)()) {
      // A key starting with "/" still yields an empty slug the guard cannot
      // catch. Seed names win, so a slug already present is left alone.
      if (slug && !byslug.has(slug)) byslug.set(slug, null)
    }
  } catch (err) {
    console.error('[catalog] could not read namespaces from the registry cache', err)
  }

  return [...byslug]
    .map(([slug, name]) => ({ slug, name }))
    .sort((a, b) => a.slug.localeCompare(b.slug))
}
