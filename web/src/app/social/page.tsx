import { redirect } from 'next/navigation'

// `social` is the legacy spelling of POSTS (`WriterActivity`'s LEGACY_TAB keeps
// it readable), and like /following it was a view rather than a page — so the
// shim names it rather than bouncing through bare /network onto the front door.
export default function SocialRedirect() {
  redirect('/reader?overlay=profile&user=me&tab=social')
}
