// =============================================================================
// Slug / d-tag generation
//
// Shared across gateway's article-indexing routes, the scheduler worker, and
// the publication publisher. The web client has its own mirror at
// web/src/lib/publish.ts (Next.js cannot cleanly import from shared/ under
// the current workspace setup); web/tests/publish.test.ts asserts identical
// output for the same input/time and is how drift is caught.
// =============================================================================

export function slugify(title: string, maxLen = 80): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, maxLen)
}

export function generateDTag(title: string): string {
  const slug = slugify(title, 80)
  const timestamp = Math.floor(Date.now() / 1000).toString(36)
  return `${slug}-${timestamp}`
}
