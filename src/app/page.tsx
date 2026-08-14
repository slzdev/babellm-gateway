import { redirect } from 'next/navigation'

export default function Home() {
  // The first thing after login should be what the gateway is doing, not how
  // it is configured.
  redirect('/dashboard')
}
