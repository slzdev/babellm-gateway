'use client'

import { useActionState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loginAction } from './actions'

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, {})

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form action={action} className="w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">BabeLLM Gateway</h1>
        <div className="space-y-2">
          <Label htmlFor="password">Admin password</Label>
          <Input id="password" name="password" type="password" autoFocus required />
        </div>
        {state?.error ? (
          <p role="alert" className="text-sm text-destructive">{state.error}</p>
        ) : null}
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </main>
  )
}
