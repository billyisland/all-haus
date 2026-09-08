import { redirect } from 'next/navigation'

// Was the reading-history shim. Its destination is now Recent reading — the
// same log under the name that states its window (READING-LOG-AND-LIBRARY-ADR
// D6), which is why the tab id moved rather than the route.
export default function HistoryRedirect() {
  redirect('/reader?overlay=library&tab=recent')
}
