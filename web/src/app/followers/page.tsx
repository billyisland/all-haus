import { redirect } from 'next/navigation'

export default function FollowersPage() {
  redirect('/reader?overlay=network&tab=followers')
}
