import { redirect } from 'next/navigation'

export default function BookmarksRedirect() {
  redirect('/reader?overlay=library')
}
