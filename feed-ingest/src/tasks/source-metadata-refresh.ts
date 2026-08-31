import type { Task } from 'graphile-worker'
import { pool } from '@platform-pub/shared/db/client.js'
import logger from '@platform-pub/shared/lib/logger.js'
import { safeFetch } from '@platform-pub/shared/lib/http-client.js'
import Parser from 'rss-parser'

// =============================================================================
// source_metadata_refresh — daily refresh of source display metadata
//
// Re-fetches RSS feeds to update display_name (feed title), description,
// and avatar_url on external_sources. Does not process items.
// =============================================================================

const parser = new Parser({ timeout: 10_000, maxRedirects: 3 })

export const sourceMetadataRefresh: Task = async (_payload, _helpers) => {
  const { rows: sources } = await pool.query<{
    id: string
    protocol: string
    source_uri: string
  }>(`
    SELECT id, protocol, source_uri FROM external_sources
    WHERE is_active = TRUE
    ORDER BY updated_at ASC
    LIMIT 200
  `)

  let updated = 0
  for (const source of sources) {
    try {
      if (source.protocol === 'rss') {
        const response = await safeFetch(source.source_uri, {
          headers: { 'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
        })
        if (!response.ok) continue

        const feed = await parser.parseString(response.text)

        await pool.query(`
          UPDATE external_sources SET
            display_name = COALESCE($2, display_name),
            description = COALESCE($3, description),
            avatar_url = COALESCE($4, avatar_url),
            updated_at = now()
          WHERE id = $1
        `, [
          source.id,
          feed.title ?? null,
          feed.description ?? null,
          feed.image?.url ?? null,
        ])
        updated++
      }
      // Other protocols added in later phases
    } catch (err) {
      logger.debug({ sourceId: source.id, err }, 'Metadata refresh failed for source')
    }
  }

  if (updated > 0) {
    logger.info({ updated }, 'Source metadata refreshed')
  }
}
