import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { AppHeader } from '@/components/app-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '#/lib/api-client'
import { MIN_PASSWORD_LENGTH } from '#/lib/password-limits'
import { ME_KEY, useMe } from '#/lib/session'

export const Route = createFileRoute('/account')({ component: AccountPage })

function AccountPage() {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')

  useEffect(() => {
    if (me.data && me.data.authMode === 'on' && !me.data.user) void navigate({ to: '/login' })
  }, [me.data, navigate])

  const change = useMutation({
    mutationFn: () => api('/api/auth/password', { method: 'POST', body: { current, next }, fallback: 'Het wachtwoord kon niet worden gewijzigd.' }),
    onSuccess: async () => {
      setCurrent('')
      setNext('')
      setRepeat('')
      await queryClient.invalidateQueries({ queryKey: ME_KEY })
    },
  })

  const mismatch = repeat !== '' && next !== repeat
  const tooShort = next !== '' && next.length < MIN_PASSWORD_LENGTH

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!change.isPending && !mismatch && !tooShort) change.mutate()
  }

  const user = me.data?.user
  return (
    <main className="min-h-screen bg-background">
      <AppHeader me={me.data} active="account" />
      <div className="mx-auto max-w-xl px-4 py-8 sm:px-6">
        {me.data?.authMode === 'off' && (
          <Alert>
            <AlertTitle>Geen accounts op deze server</AlertTitle>
            <AlertDescription>Inloggen staat hier uit, dus er is geen account om te beheren.</AlertDescription>
          </Alert>
        )}
        {user && (
          <Card>
            <CardHeader>
              <CardTitle>{user.name}</CardTitle>
              <CardDescription>
                Gebruikersnaam <strong>{user.username}</strong> · {user.role === 'admin' ? 'planner' : 'monteur'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {user.emergency ? (
                <p className="text-sm text-muted-foreground">Het wachtwoord van het noodaccount staat in de serverinstellingen en wijzig je daar.</p>
              ) : (
                <form onSubmit={submit} className="grid gap-4" noValidate>
                  <h2 className="text-sm font-semibold">Wachtwoord wijzigen</h2>
                  <div className="grid gap-1.5">
                    <Label htmlFor="current">Huidig wachtwoord</Label>
                    <Input id="current" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="next">Nieuw wachtwoord</Label>
                    <Input id="next" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
                    <p className={`text-xs ${tooShort ? 'text-destructive' : 'text-muted-foreground'}`}>Minstens {MIN_PASSWORD_LENGTH} tekens.</p>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="repeat">Nieuw wachtwoord nog een keer</Label>
                    <Input id="repeat" type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} />
                    {mismatch && <p className="text-xs text-destructive">De twee wachtwoorden zijn niet gelijk.</p>}
                  </div>
                  {change.isError && (
                    <Alert variant="destructive">
                      <AlertTitle>Niet gewijzigd</AlertTitle>
                      <AlertDescription>{change.error.message}</AlertDescription>
                    </Alert>
                  )}
                  {change.isSuccess && (
                    <Alert>
                      <AlertTitle>Wachtwoord gewijzigd</AlertTitle>
                      <AlertDescription>Je blijft ingelogd op dit apparaat; op andere apparaten log je opnieuw in.</AlertDescription>
                    </Alert>
                  )}
                  <Button type="submit" disabled={change.isPending || !current || !next || !repeat || mismatch || tooShort}>
                    {change.isPending ? 'Bezig' : 'Wachtwoord wijzigen'}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  )
}
