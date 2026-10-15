import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CalendarOff, CheckCircle2, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { AppHeader } from '@/components/app-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api } from '#/lib/api-client'
import type { AvailabilityOdoo, AvailabilityPeriod, AvailabilityResponse } from '#/lib/availability-types'
import { useMe } from '#/lib/session'

export const Route = createFileRoute('/beschikbaarheid')({ component: Availability })

const KEY = ['availability']
const NOTE_MAX = 200

/** `2026-10-07` as "wo 7 okt. 2026"; the day is shown as it is, never moved by a time zone. */
const day = (iso: string) =>
  new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))

function Availability() {
  const me = useMe()
  const navigate = useNavigate()
  const user = me.data?.user ?? null

  useEffect(() => {
    if (me.data && me.data.authMode === 'on' && !me.data.user) void navigate({ to: '/login' })
  }, [me.data, navigate])

  const periods = useQuery({
    queryKey: KEY,
    queryFn: () => api<AvailabilityResponse>('/api/availability', { fallback: 'De beschikbaarheid kon niet worden geladen.' }),
    enabled: user !== null,
  })

  return (
    <main className="min-h-screen bg-background">
      <AppHeader me={me.data} active="availability" />
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 sm:px-6">
        {me.data?.authMode === 'off' && (
          <Alert>
            <AlertTitle>Geen accounts op deze server</AlertTitle>
            <AlertDescription>Inloggen staat hier uit, dus beschikbaarheid doorgeven kan hier niet.</AlertDescription>
          </Alert>
        )}
        {periods.isError && (
          <Alert variant="destructive">
            <AlertTitle>De beschikbaarheid kon niet worden geladen</AlertTitle>
            <AlertDescription>{periods.error.message}</AlertDescription>
          </Alert>
        )}
        {periods.data?.canEdit && <GiveAvailability today={periods.data.today} />}
        {periods.data && <PeriodsTable data={periods.data} linkedToOdoo={(user?.personId ?? '').startsWith('employee:')} />}
      </div>
    </main>
  )
}

/* ---------------------------------------------------------------- Doorgeven (monteur) */

function GiveAvailability({ today }: { today: string }) {
  const queryClient = useQueryClient()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState<{ from: string; to: string } | null>(null)

  const add = useMutation({
    mutationFn: () =>
      api<{ period: { id: string; from: string; to: string; note: string } }>('/api/availability', {
        method: 'POST',
        body: { from, to, ...(note.trim() && { note: note.trim() }) },
        fallback: 'Doorgeven is niet gelukt.',
      }),
    onSuccess: async (result) => {
      setSaved({ from: result.period.from, to: result.period.to })
      setFrom('')
      setTo('')
      setNote('')
      await queryClient.invalidateQueries({ queryKey: KEY })
    },
  })

  function changeFrom(value: string) {
    setFrom(value)
    setSaved(null)
    // The last day is never before the first day: for a single day it follows the first day.
    if (value && (!to || to < value)) setTo(value)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!add.isPending && from && to) add.mutate()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><CalendarOff className="size-5" /> Niet beschikbaar doorgeven</CardTitle>
        <CardDescription>
          Geef de dagen door waarop je niet beschikbaar bent, bijvoorbeeld vakantie, ziekte of een afspraak. Voor één dag vul je alleen de eerste dag in: de laatste dag volgt vanzelf.
          De planner ziet dit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="availability-from">Eerste dag</Label>
            <Input id="availability-from" type="date" value={from} min={today} onChange={(event) => changeFrom(event.target.value)} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="availability-to">Laatste dag</Label>
            <Input id="availability-to" type="date" value={to} min={from || today} onChange={(event) => { setTo(event.target.value); setSaved(null) }} required />
          </div>
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="availability-note">Opmerking (niet verplicht)</Label>
            <Input id="availability-note" value={note} maxLength={NOTE_MAX} onChange={(event) => { setNote(event.target.value); setSaved(null) }} placeholder="Bijvoorbeeld: vakantie" />
          </div>
          {add.isError && (
            <div className="md:col-span-2">
              <Alert variant="destructive">
                <AlertTitle>Niet doorgegeven</AlertTitle>
                <AlertDescription>{add.error.message}</AlertDescription>
              </Alert>
            </div>
          )}
          {saved && (
            <div className="md:col-span-2">
              <Alert>
                <CheckCircle2 className="size-4" />
                <AlertTitle>Doorgegeven</AlertTitle>
                <AlertDescription>
                  {saved.from === saved.to ? <>Je bent niet beschikbaar op {day(saved.from)}.</> : <>Je bent niet beschikbaar van {day(saved.from)} tot en met {day(saved.to)}.</>}
                </AlertDescription>
              </Alert>
            </div>
          )}
          <div className="md:col-span-2">
            <Button type="submit" disabled={add.isPending || !from || !to}>{add.isPending ? 'Bezig met doorgeven' : 'Doorgeven'}</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

/* ---------------------------------------------------------------- Overzicht */

/** What the planner and the technician see about the record in Odoo, in a few words. */
function OdooState({ odoo }: { odoo: AvailabilityOdoo }) {
  if (odoo.state === 'synced') return <Badge variant="secondary">{odoo.verified ? 'In Odoo' : 'In Odoo (niet gecontroleerd)'}</Badge>
  if (odoo.state === 'none') return <Badge variant="outline">Alleen in dashboard</Badge>
  return (
    <div className="space-y-1">
      <Badge variant="destructive">{odoo.state === 'failed' ? 'Niet in Odoo gekomen' : 'Onzeker of in Odoo'}</Badge>
      <p className="max-w-[16rem] text-xs text-muted-foreground">{odoo.message}</p>
    </div>
  )
}

function PeriodsTable({ data, linkedToOdoo }: { data: AvailabilityResponse; linkedToOdoo: boolean }) {
  const queryClient = useQueryClient()
  const [warning, setWarning] = useState<string | null>(null)
  const remove = useMutation({
    mutationFn: (period: AvailabilityPeriod) => api<{ ok: true; warning?: string }>(`/api/availability/${period.id}`, { method: 'DELETE', fallback: 'Verwijderen is niet gelukt.' }),
    onSuccess: (result) => setWarning(result.warning ?? null),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })
  const retry = useMutation({
    mutationFn: (period: AvailabilityPeriod) => api(`/api/availability/${period.id}/retry`, { method: 'POST', fallback: 'Opnieuw naar Odoo sturen is niet gelukt.' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: KEY }),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.canEdit ? 'Mijn doorgegeven periodes' : 'Beschikbaarheid van de monteurs'}</CardTitle>
        <CardDescription>
          {data.canEdit ? 'Periodes die nog niet voorbij zijn.' : 'Periodes waarin een monteur niet beschikbaar is, die nog niet voorbij zijn.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {remove.isError && (
          <Alert variant="destructive">
            <AlertTitle>Niet verwijderd</AlertTitle>
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        )}
        {retry.isError && (
          <Alert variant="destructive">
            <AlertTitle>Niet naar Odoo gestuurd</AlertTitle>
            <AlertDescription>{retry.error.message}</AlertDescription>
          </Alert>
        )}
        {warning && (
          <Alert>
            <AlertTitle>Controleer dit in Odoo</AlertTitle>
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        )}
        {data.periods.length === 0 ? (
          <p className="text-sm text-muted-foreground">{data.canEdit ? 'Je hebt niets doorgegeven.' : 'Niemand heeft iets doorgegeven.'}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {!data.canEdit && <TableHead>Monteur</TableHead>}
                <TableHead>Eerste dag</TableHead>
                <TableHead>Laatste dag</TableHead>
                <TableHead>Opmerking</TableHead>
                <TableHead>Odoo</TableHead>
                {data.canEdit && <TableHead className="text-right">Acties</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.periods.map((period) => (
                <TableRow key={period.id}>
                  {!data.canEdit && <TableCell className="font-medium">{period.name}</TableCell>}
                  <TableCell>{day(period.from)}</TableCell>
                  <TableCell>{day(period.to)}</TableCell>
                  <TableCell className="max-w-[18rem] break-words">{period.note || <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell><OdooState odoo={period.odoo} /></TableCell>
                  {data.canEdit && (
                    <TableCell className="text-right">
                      <div className="flex flex-wrap justify-end gap-2">
                        {linkedToOdoo && (period.odoo.state === 'failed' || period.odoo.state === 'none') && (
                          <Button type="button" variant="outline" size="sm" onClick={() => retry.mutate(period)} disabled={retry.isPending}>
                            <RefreshCw className="size-4" /> Naar Odoo sturen
                          </Button>
                        )}
                        <Button type="button" variant="outline" size="sm" onClick={() => remove.mutate(period)} disabled={remove.isPending}>
                          <Trash2 className="size-4" /> Verwijderen
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
