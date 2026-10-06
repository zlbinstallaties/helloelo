import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ImageIcon,
  MapPin,
  RefreshCw,
  Route as RouteIcon,
  SlidersHorizontal,
  UserRound,
  UsersRound,
  Wrench,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ReactNode } from 'react'
import { AppHeader } from '@/components/app-header'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ApiError } from '#/lib/api-client'
import { dashboardParams, requestDashboard } from '#/lib/dashboard-client'
import type { DashboardAppointment, DashboardAppointmentVisit, DashboardResponse } from '#/lib/dashboard-types'
import { MAX_RECORDS } from '#/lib/paging'
import { useMe } from '#/lib/session'

export const Route = createFileRoute('/')({ component: Dashboard })

const formatter = new Intl.DateTimeFormat('nl-NL', {
  timeZone: 'Europe/Amsterdam',
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})

function todayInAmsterdam() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date())
}

function formatTime(value: string | null) {
  if (!value) return 'Niet gepland'
  return new Intl.DateTimeFormat('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(`${value.replace(' ', 'T')}Z`))
}

function formatLoadedAt(iso: string) {
  return new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
}

function formatDate(value: string) {
  return formatter.format(new Date(`${value}T12:00:00Z`))
}

function Dashboard() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useMe()
  // Logins on and nobody logged in: to the login screen. Everything below waits until it is clear who is looking.
  const needsLogin = me.data?.authMode === 'on' && !me.data.user
  const ready = Boolean(me.data) && !needsLogin
  const isMonteur = me.data?.user?.role === 'monteur'
  const canRefresh = me.data?.canRefresh === true
  useEffect(() => {
    if (needsLogin) void navigate({ to: '/login' })
  }, [needsLogin, navigate])
  const [date, setDate] = useState(todayInAmsterdam)
  const [scope, setScope] = useState<DashboardResponse['scope']>('day')
  const [technician, setTechnician] = useState('')
  const [selected, setSelected] = useState<DashboardAppointment | null>(null)
  const queryKey = ['dig-dashboard', date, scope, technician]
  const query = useQuery({
    queryKey,
    queryFn: () => requestDashboard(dashboardParams(date, scope, technician), 'GET', 'De afspraken konden niet worden geladen.'),
    staleTime: 60_000,
    enabled: ready,
    // A session that ended is not an error to try again.
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
  })
  const sessionEnded = query.error instanceof ApiError && query.error.status === 401
  useEffect(() => {
    if (sessionEnded) {
      queryClient.clear()
      void navigate({ to: '/login' })
    }
  }, [sessionEnded, queryClient, navigate])

  // The POST answers with the fresh data for this view, so it is used as is: no second read of Odoo behind it.
  // When Odoo cannot be read the old data stays on screen and the failure is shown, with how old that data is.
  const refresh = useMutation({
    mutationFn: () => requestDashboard(dashboardParams(date, scope, technician), 'POST', 'De gegevens konden niet worden vernieuwd.'),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data)
      void queryClient.invalidateQueries({ queryKey: ['dig-dashboard'], refetchType: 'none' })
    },
    onError: (error) => {
      const loadedAt = query.data?.loadedAt
      toast.error(`Vernieuwen mislukt: ${error.message}`, {
        description: loadedAt ? `Je ziet nog de gegevens van ${formatLoadedAt(loadedAt)}.` : undefined,
      })
    },
  })

  const appointments = query.data?.appointments ?? []
  const scheduledCount = appointments.filter((item) => item.scheduled).length
  const unplannedCount = appointments.filter((item) => !item.scheduled).length

  return (
    <main className="min-h-screen bg-background">
      <AppHeader me={me.data} active="dashboard" />

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <section className="mb-8 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <p className="mb-2 text-sm font-medium text-primary">{query.data?.company.name ?? 'De Installatiegroep B.V. [TEST]'}</p>
            <h2 className="max-w-2xl text-3xl font-semibold leading-tight sm:text-4xl">{isMonteur ? 'Jouw werkdag, helder in beeld.' : 'De werkdag van je monteurs, helder in beeld.'}</h2>
            {!isMonteur && (
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">Planning komt uit <code className="rounded bg-muted px-1.5 py-0.5 text-xs">planning.slot</code>. DIG-bezoeken worden aangevuld vanuit <code className="rounded bg-muted px-1.5 py-0.5 text-xs">svs.tech.visit</code>.</p>
            )}
          </div>
          {canRefresh && (
            <button type="button" onClick={() => refresh.mutate()} disabled={query.isFetching || refresh.isPending} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold shadow-sm transition hover:bg-muted disabled:cursor-wait disabled:opacity-60">
              <RefreshCw className={`size-4 ${query.isFetching || refresh.isPending ? 'animate-spin' : ''}`} /> Ververs Odoo-data
            </button>
          )}
        </section>

        <section className="mb-6 grid gap-3 sm:grid-cols-3" aria-label="Overzicht">
          <SummaryCard icon={<CalendarDays />} label={scope === 'day' ? 'Afspraken vandaag' : 'Getoonde afspraken'} value={appointments.length} detail={`${scheduledCount} gepland`} />
          <SummaryCard icon={<Wrench />} label="DIG-bezoeken" value={appointments.reduce((sum, item) => sum + item.visits.length, 0)} detail={`${unplannedCount} zonder planning`} />
          <SummaryCard icon={<AlertTriangle />} label="Aandacht nodig" value={appointments.filter((item) => (item.missingRequired ?? 0) > 0 || !item.assigned).length} detail="ontbrekend of niet toegewezen" tone="warning" />
        </section>

        <section className="mb-7 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5" aria-label="Filters">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold"><SlidersHorizontal className="size-4 text-primary" /> Weergave</div>
          <div className={`grid gap-3 md:items-end ${isMonteur ? 'md:grid-cols-[1fr_1.2fr_auto]' : 'md:grid-cols-[1fr_1fr_1.2fr_auto]'}`}>
            <label className="grid gap-1.5 text-sm font-medium">Datum<input type="date" value={date} onChange={(event) => { setDate(event.target.value); setScope('day'); setSelected(null) }} className="h-10 rounded-xl border border-input bg-background px-3 font-normal outline-none ring-offset-background focus:ring-2 focus:ring-ring" /></label>
            {!isMonteur && (
              <label className="grid gap-1.5 text-sm font-medium">Monteur<select value={technician} onChange={(event) => { setTechnician(event.target.value); setSelected(null) }} className="h-10 rounded-xl border border-input bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring"><option value="">Alle monteurs</option>{query.data?.technicians.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            )}
            <div className="grid gap-1.5 text-sm font-medium"><span>Periode</span><div className="flex h-10 rounded-xl border border-input bg-background p-1">{(['day', 'upcoming', 'all'] as const).map((item) => <button key={item} type="button" onClick={() => { setScope(item); setSelected(null) }} className={`flex-1 rounded-lg px-3 text-xs font-semibold transition ${scope === item ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>{item === 'day' ? 'Vandaag' : item === 'upcoming' ? 'Komend' : 'Alle'}</button>)}</div></div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="size-2 rounded-full bg-chart-2" /> Cache: maximaal 5 minuten</div>
          </div>
        </section>

        {query.data?.truncated && (
          <Alert className="mb-6 border-chart-4/60 bg-chart-4/10">
            <AlertTriangle className="size-4" />
            <AlertTitle>Niet alle gegevens uit Odoo zijn geladen</AlertTitle>
            <AlertDescription>Het dashboard leest maximaal {MAX_RECORDS.toLocaleString('nl-NL')} planningen en {MAX_RECORDS.toLocaleString('nl-NL')} bezoeken, de nieuwste eerst. De oudste ontbreken, en een bezoek kan daardoor als "Niet gepland" verschijnen.</AlertDescription>
          </Alert>
        )}
        {(me.isLoading || needsLogin || query.isLoading) && <LoadingState />}
        {query.isError && <ErrorState message={query.error.message} onRetry={() => query.refetch()} />}
        {!query.isLoading && !query.isError && appointments.length === 0 && <EmptyState date={date} scope={scope} onUpcoming={() => setScope('upcoming')} onAll={() => setScope('all')} />}
        {!query.isLoading && !query.isError && appointments.length > 0 && <Appointments key={`${date}|${scope}|${technician}`} appointments={appointments} onSelect={setSelected} />}
      </div>

      {selected && <DetailPanel appointment={selected} onClose={() => setSelected(null)} />}
    </main>
  )
}

function SummaryCard({ icon, label, value, detail, tone = 'default' }: { icon: ReactNode; label: string; value: number; detail: string; tone?: 'default' | 'warning' }) {
  return <div className="rounded-2xl border border-border bg-card p-4 shadow-sm"><div className="flex items-center justify-between"><span className="flex size-9 items-center justify-center rounded-xl bg-muted text-primary">{icon}</span><span className="text-3xl font-semibold tracking-tight">{value}</span></div><p className="mt-4 text-sm font-semibold">{label}</p><p className={`mt-1 text-xs ${tone === 'warning' ? 'text-destructive' : 'text-muted-foreground'}`}>{detail}</p></div>
}

// A long list is shown in parts: rendering thousands of cards at once takes seconds (docs/verification.md).
const LIST_STEP = 100

function Appointments({ appointments, onSelect }: { appointments: DashboardAppointment[]; onSelect: (appointment: DashboardAppointment) => void }) {
  const [visible, setVisible] = useState(LIST_STEP)
  const shown = appointments.slice(0, visible)
  const remaining = appointments.length - shown.length
  const count = (value: number) => value.toLocaleString('nl-NL')
  return (
    <section aria-label="Afspraken" className="space-y-3">
      {shown.map((appointment) => <AppointmentCard key={appointment.id} appointment={appointment} onSelect={() => onSelect(appointment)} />)}
      {appointments.length > LIST_STEP && (
        <div className="flex flex-col items-center gap-3 pt-3">
          <p className="text-sm text-muted-foreground" aria-live="polite">{remaining > 0 ? `${count(shown.length)} van ${count(appointments.length)} afspraken getoond` : `Alle ${count(appointments.length)} afspraken getoond`}</p>
          {remaining > 0 && <button type="button" onClick={() => setVisible((current) => current + LIST_STEP)} className="inline-flex h-10 items-center justify-center rounded-xl border border-border bg-card px-4 text-sm font-semibold shadow-sm transition hover:bg-muted">Toon {count(Math.min(LIST_STEP, remaining))} meer</button>}
        </div>
      )}
    </section>
  )
}

function AppointmentCard({ appointment, onSelect }: { appointment: DashboardAppointment; onSelect: () => void }) {
  const attention = !appointment.assigned || (appointment.missingRequired ?? 0) > 0
  return <article className={`group rounded-2xl border bg-card p-4 shadow-sm transition hover:border-primary/40 hover:shadow-md sm:p-5 ${attention ? 'border-chart-4/60' : 'border-border'}`}><div className="flex flex-col gap-4 sm:flex-row sm:items-start"><div className="flex shrink-0 items-center gap-2 text-sm font-semibold sm:w-28 sm:flex-col sm:items-start sm:gap-0.5"><span>{formatTime(appointment.start)}</span><span className="text-xs font-normal text-muted-foreground">{appointment.end ? `tot ${formatTime(appointment.end)}` : 'bezoekformulier'}</span></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-base font-semibold">{appointment.customer}</h3>{!appointment.scheduled && <Badge icon={<AlertTriangle />} tone="warning">Niet gepland</Badge>}{!appointment.assigned && <Badge icon={<UserRound />} tone="warning">Niet toegewezen</Badge>}{appointment.visitId && <Badge icon={<CheckCircle2 />} tone={appointment.state === 'in_progress' ? 'info' : 'neutral'}>{stateLabel(appointment.state)}</Badge>}</div><p className="mt-1 truncate text-sm text-muted-foreground">{appointment.title}</p><div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5" />{appointment.address}</span><span className="inline-flex items-center gap-1.5"><UsersRound className="size-3.5" />{appointment.people.length ? appointment.people.map((person) => person.name).join(', ') : 'Geen monteur'}</span><span className="inline-flex items-center gap-1.5"><Wrench className="size-3.5" />{appointment.role}</span></div></div><button type="button" onClick={onSelect} className="inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-xl border border-border px-3 text-sm font-semibold transition hover:bg-muted">Details<ChevronRight className="size-4" /></button></div>{(appointment.missingRequired !== null || appointment.photoCount !== null) && <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3 text-xs"><Metric icon={<AlertTriangle />} label="Ontbrekend verplicht" value={appointment.missingRequired ?? 0} danger={(appointment.missingRequired ?? 0) > 0} /><Metric icon={<ImageIcon />} label="Foto's" value={appointment.photoCount ?? 0} /><Metric icon={<RouteIcon />} label="Reistijd" value={appointment.travelTimesUpToDate ? `${(appointment.travelTimeIn ?? 0) + (appointment.travelTimeOut ?? 0)} min` : 'Niet beschikbaar'} /></div>}</article>
}

function Metric({ icon, label, value, danger = false }: { icon: ReactNode; label: string; value: string | number; danger?: boolean }) { return <span className={`inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 ${danger ? 'text-destructive' : 'text-muted-foreground'}`}><span className="inline-flex size-3.5 shrink-0 [&>svg]:size-full">{icon}</span><span>{label}: <strong className="font-semibold">{value}</strong></span></span> }
function Badge({ children, icon, tone }: { children: ReactNode; icon: ReactNode; tone: 'warning' | 'info' | 'neutral' }) { return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${tone === 'warning' ? 'bg-chart-4/20 text-foreground' : tone === 'info' ? 'bg-chart-2/20 text-foreground' : 'bg-muted text-muted-foreground'}`}><span className="inline-flex size-3 shrink-0 [&>svg]:size-full">{icon}</span>{children}</span> }

function DetailPanel({ appointment, onClose }: { appointment: DashboardAppointment; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex justify-end bg-foreground/20" role="dialog" aria-modal="true" aria-label={`Details ${appointment.customer}`} onClick={onClose}><aside className="h-full w-full max-w-lg overflow-y-auto border-l border-border bg-card p-5 shadow-2xl sm:p-7" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Afspraakdetails</p><h2 className="mt-2 text-2xl font-semibold">{appointment.customer}</h2><p className="mt-1 text-sm text-muted-foreground">{appointment.title}</p></div><button type="button" onClick={onClose} aria-label="Sluiten" className="rounded-xl p-2 text-muted-foreground hover:bg-muted"><X className="size-5" /></button></div><div className="mt-7 grid gap-3 sm:grid-cols-2"><Detail label="Datum" value={formatDate(appointment.visitDate)} icon={<CalendarDays />} /><Detail label="Tijd" value={appointment.start ? `${formatTime(appointment.start)} – ${formatTime(appointment.end)}` : 'Niet gepland'} icon={<Clock3 />} /><Detail label="Adres" value={appointment.address} icon={<MapPin />} /><Detail label="Rol" value={appointment.role} icon={<Wrench />} /><Detail label="Toegewezen" value={appointment.people.length ? appointment.people.map((person) => person.name).join(', ') : 'Niemand'} icon={<UsersRound />} /><Detail label="Status" value={stateLabel(appointment.state)} icon={<CheckCircle2 />} /></div><div className="mt-6 rounded-2xl bg-muted p-4"><p className="text-sm font-semibold">{appointment.visits.length > 1 ? `DIG-bezoekformulieren (${appointment.visits.length})` : 'DIG-bezoekformulier'}</p><div className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-muted-foreground">Ontbrekende verplichte onderdelen{appointment.visits.length > 1 ? ' (totaal)' : ''}</p><p className="mt-1 text-lg font-semibold">{appointment.missingRequired ?? 'Niet beschikbaar'}</p></div><div><p className="text-xs text-muted-foreground">Foto's vastgelegd{appointment.visits.length > 1 ? ' (totaal)' : ''}</p><p className="mt-1 text-lg font-semibold">{appointment.photoCount ?? 'Niet beschikbaar'}</p></div></div>{appointment.missingInputs !== null && <p className="mt-3 text-xs text-muted-foreground">Ontbrekende verplichte invoervelden{appointment.visits.length > 1 ? ' (totaal)' : ''}: {appointment.missingInputs}</p>}</div>{appointment.visits.length > 1 && <VisitList visits={appointment.visits} />}{appointment.travelTimesUpToDate && <div className="mt-4 rounded-2xl border border-border p-4"><p className="text-sm font-semibold">Beschikbare reistijd</p><p className="mt-1 text-sm text-muted-foreground">Heen {appointment.travelTimeIn ?? 0} min · terug {appointment.travelTimeOut ?? 0} min</p></div>}{appointment.visits.length === 1 && appointment.odooUrl && <a href={appointment.odooUrl} target="_blank" rel="noreferrer" className="mt-6 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90">Open bestaand bezoekformulier in Odoo<ArrowUpRight className="size-4" /></a>}<p className="mt-4 text-center text-xs leading-5 text-muted-foreground">Dit dashboard wijzigt het bezoekformulier niet.</p></aside></div>
}

function VisitList({ visits }: { visits: DashboardAppointmentVisit[] }) {
  return <section aria-label="Bezoeken van deze afspraak" className="mt-4 space-y-3"><p className="text-sm font-semibold">Bezoeken van deze afspraak</p>{visits.map((visit) => <div key={visit.id} className="rounded-2xl border border-border p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold">{visit.name || `Bezoek ${visit.id}`}</p><Badge icon={<CheckCircle2 />} tone={visit.state === 'in_progress' ? 'info' : 'neutral'}>{stateLabel(visit.state)}</Badge></div><p className="mt-1 text-xs text-muted-foreground">{[visit.visitDate ? formatDate(visit.visitDate) : 'Geen bezoekdatum', visit.technician ?? 'Geen technicus', visit.template].filter(Boolean).join(' · ')}</p><div className="mt-3 flex flex-wrap gap-2 text-xs"><Metric icon={<AlertTriangle />} label="Ontbrekend verplicht" value={visit.missingRequired} danger={visit.missingRequired > 0} /><Metric icon={<AlertTriangle />} label="Ontbrekende invoer" value={visit.missingInputs} danger={visit.missingInputs > 0} /><Metric icon={<ImageIcon />} label="Foto's" value={visit.photoCount} /><Metric icon={<CheckCircle2 />} label="Compleet" value={visit.isComplete ? 'Ja' : 'Nee'} /><Metric icon={<ArrowUpRight />} label="Verzonden" value={visit.isSent ? 'Ja' : 'Nee'} /></div>{visit.odooUrl && <a href={visit.odooUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">Open in Odoo<ArrowUpRight className="size-4" /></a>}</div>)}</section>
}

function Detail({ label, value, icon }: { label: string; value: string; icon: ReactNode }) { return <div className="rounded-xl border border-border p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="text-primary">{icon}</span>{label}</div><p className="mt-2 text-sm font-semibold leading-5">{value}</p></div> }
function stateLabel(state: string) { const labels: Record<string, string> = { in_progress: 'In uitvoering', done: 'Afgerond', draft: 'Concept', '1_draft': 'Concept', '2_confirmed': 'Bevestigd' }; return labels[state] ?? state.replaceAll('_', ' ') }
function LoadingState() { return <div className="rounded-2xl border border-border bg-card p-10 text-center shadow-sm"><RefreshCw className="mx-auto size-6 animate-spin text-primary" /><p className="mt-4 text-sm font-semibold">Odoo-afspraken laden</p><p className="mt-1 text-sm text-muted-foreground">De planning en DIG-bezoekformulieren worden opgehaald.</p></div> }
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="rounded-2xl border border-destructive/40 bg-card p-8 text-center shadow-sm"><AlertTriangle className="mx-auto size-7 text-destructive" /><p className="mt-4 text-sm font-semibold">Odoo-data kon niet worden geladen</p><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{message}</p><button type="button" onClick={onRetry} className="mt-5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Opnieuw proberen</button></div> }
function EmptyState({ date, scope, onUpcoming, onAll }: { date: string; scope: DashboardResponse['scope']; onUpcoming: () => void; onAll: () => void }) { return <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-14 text-center shadow-sm"><div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted text-primary"><CalendarDays className="size-7" /></div><h3 className="mt-5 text-xl font-semibold">Geen afspraken in deze weergave</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">Er zijn geen Odoo-records gevonden voor {scope === 'day' ? formatDate(date) : scope === 'upcoming' ? 'de komende periode' : 'de gekozen selectie'}. Er is niets verzonnen.</p><div className="mt-6 flex flex-wrap justify-center gap-2"><button type="button" onClick={onUpcoming} className="rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-muted">Bekijk komende afspraken</button><button type="button" onClick={onAll} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Bekijk alle afspraken</button></div></div> }
