import { redirect } from 'next/navigation'

// The workspace was renamed to /reader (the universal reading surface). This
// route is retained only as a compatibility shim: old bookmarks and deep links
// pointing at /workspace[?overlay=…] redirect into /reader, preserving every
// query param (overlay seeds, tabs, context) untouched.
export default function WorkspaceRedirect({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') params.set(key, value)
    else if (Array.isArray(value)) value.forEach((v) => params.append(key, v))
  }
  const qs = params.toString()
  redirect(qs ? `/reader?${qs}` : '/reader')
}
