import { redirect } from 'next/navigation'

export default function HistoryRedirect() {
  redirect('/reader?overlay=library&tab=history')
}
