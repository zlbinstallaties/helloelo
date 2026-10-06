import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { LogIn, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '#/lib/api-client'
import { ME_KEY, useMe } from '#/lib/session'

export const Route = createFileRoute('/login')({ component: LoginPage })

function LoginPage() {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  // Already logged in, or no logins on this server: nothing to do here.
  useEffect(() => {
    if (me.data && (me.data.authMode === 'off' || me.data.user)) void navigate({ to: '/' })
  }, [me.data, navigate])

  const login = useMutation({
    mutationFn: () => api('/api/auth/login', { method: 'POST', body: { username, password }, fallback: 'Inloggen is niet gelukt.' }),
    onSuccess: async () => {
      // Whatever an earlier person left in this browser is gone before the next one sees anything.
      queryClient.clear()
      await queryClient.invalidateQueries({ queryKey: ME_KEY })
      await navigate({ to: '/' })
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!login.isPending) login.mutate()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Wrench className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Monteursdashboard</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Inloggen</CardTitle>
            <CardDescription>Log in met het account dat je van de planner hebt gekregen.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-4" noValidate>
              <div className="grid gap-1.5">
                <Label htmlFor="username">Gebruikersnaam</Label>
                <Input id="username" name="username" autoComplete="username" autoCapitalize="none" autoCorrect="off" value={username} onChange={(event) => setUsername(event.target.value)} required />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="password">Wachtwoord</Label>
                <Input id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </div>
              {login.isError && (
                <Alert variant="destructive">
                  <AlertTitle>Inloggen is niet gelukt</AlertTitle>
                  <AlertDescription>{login.error.message}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={login.isPending || !username || !password}>
                <LogIn className="size-4" /> {login.isPending ? 'Bezig met inloggen' : 'Inloggen'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
