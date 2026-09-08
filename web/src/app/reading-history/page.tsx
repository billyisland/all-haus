import { redirect } from 'next/navigation'

// See /history — same destination, same reason.
export default function ReadingHistoryRedirect() {
  redirect('/reader?overlay=library&tab=recent')
}
