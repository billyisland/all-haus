import { redirect } from 'next/navigation'

export default function ReadingHistoryRedirect() {
  redirect('/reader?overlay=library&tab=history')
}
