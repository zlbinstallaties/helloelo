import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
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
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { DashboardAppointment, DashboardResponse } from '#/lib/dashboard-types'

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

function formatDate(value: string) {
  return formatter.format(new Date(`${value}T12:00:00Z`))
}

function Dashboard() {
  const queryClient = useQueryClient()
  const [date, setDate] = useState(todayInAmsterdam)
  const [scope, setScope] = useState<DashboardResponse['scope']>('day')
  const [technician, setTechnician] = useState('')
  const [selected, setSelected] = useState<DashboardAppointment | null>(null)
  const queryKey = ['dig-dashboard', date, scope, technician]
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams({ date, scope })
      if (technician) params.set('technician', technician)
      const response = await fetch(`/api/dashboard?${params}`)
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error ?? 'De afspraken konden niet worden geladen.')
      return payload as DashboardResponse
    },
    staleTime: 60_000,
  })

  async function refresh() {
    const params = new URLSearchParams({ date, scope })
    if (technician) params.set('technician', technician)
    await fetch(`/api/dashboard?${params}`, { method: 'POST' })
    await queryClient.invalidateQueries({ queryKey })
  }

  const appointments = query.data?.appointments ?? []
  const scheduledCount = appointments.filter((item) => item.scheduled).length
  const unplannedCount = appointments.filter((item) => !item.scheduled).length

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
              <Wrench className="size-5" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">DIG · Odoo 20</p>
              <h1 className="text-xl font-semibold tracking-tight">Monteursdashboard</h1>
            </div>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-border bg-muted px-3 py-2 text-xs font-medium text-muted-foreground sm:flex">
            <span className="size-2 rounded-full bg-chart-2" /> Alleen-lezen · testomgeving
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <section className="mb-8 flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <p className="mb-2 text-sm font-medium text-primary">{query.data?.company.name ?? 'De Installatiegroep B.V. [TEST]'}</p>
            <h2 className="max-w-2xl text-3xl font-semibold leading-tight sm:text-4xl">De werkdag van je monteurs, helder in beeld.</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">Planning komt uit <code className="rounded bg-muted px-1.5 py-0.5 text-xs">planning.slot</code>. DIG-bezoeken worden aangevuld vanuit <code className="rounded bg-muted px-1.5 py-0.5 text-xs">svs.tech.visit</code>.</p>
          </div>
          <button type="button" onClick={refresh} disabled={query.isFetching} className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 text-sm font-semibold shadow-sm transition hover:bg-muted disabled:cursor-wait disabled:opacity-60">
            <RefreshCw className={`size-4 ${query.isFetching ? 'animate-spin' : ''}`} /> Ververs Odoo-data
          </button>
        </section>

        <section className="mb-6 grid gap-3 sm:grid-cols-3" aria-label="Overzicht">
          <SummaryCard icon={<CalendarDays />} label={scope === 'day' ? 'Afspraken vandaag' : 'Getoonde afspraken'} value={appointments.length} detail={`${scheduledCount} gepland`} />
          <SummaryCard icon={<Wrench />} label="DIG-bezoeken" value={appointments.filter((item) => item.visitId).length} detail={`${unplannedCount} zonder planning`} />
          <SummaryCard icon={<AlertTriangle />} label="Aandacht nodig" value={appointments.filter((item) => (item.missingRequired ?? 0) > 0 || !item.assigned).length} detail="ontbrekend of niet toegewezen" tone="warning" />
        </section>

        <section className="mb-7 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5" aria-label="Filters">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold"><SlidersHorizontal className="size-4 text-primary" /> Weergave</div>
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_1.2fr_auto] md:items-end">
            <label className="grid gap-1.5 text-sm font-medium">Datum<input type="date" value={date} onChange={(event) => { setDate(event.target.value); setScope('day'); setSelected(null) }} className="h-10 rounded-xl border border-input bg-background px-3 font-normal outline-none ring-offset-background focus:ring-2 focus:ring-ring" /></label>
            <label className="grid gap-1.5 text-sm font-medium">Monteur<select value={technician} onChange={(event) => { setTechnician(event.target.value); setSelected(null) }} className="h-10 rounded-xl border border-input bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring"><option value="">Alle monteurs</option>{query.data?.technicians.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
            <div className="grid gap-1.5 text-sm font-medium"><span>Periode</span><div className="flex h-10 rounded-xl border border-input bg-background p-1">{(['day', 'upcoming', 'all'] as const).map((item) => <button key={item} type="button" onClick={() => { setScope(item); setSelected(null) }} className={`flex-1 rounded-lg px-3 text-xs font-semibold transition ${scope === item ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>{item === 'day' ? 'Vandaag' : item === 'upcoming' ? 'Komend' : 'Alle'}</button>)}</div></div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="size-2 rounded-full bg-chart-2" /> Cache: maximaal 5 minuten</div>
          </div>
        </section>

        {query.isLoading && <LoadingState />}
        {query.isError && <ErrorState message={query.error.message} onRetry={() => query.refetch()} />}
        {!query.isLoading && !query.isError && appointments.length === 0 && <EmptyState date={date} scope={scope} onUpcoming={() => setScope('upcoming')} onAll={() => setScope('all')} />}
        {!query.isLoading && !query.isError && appointments.length > 0 && <Appointments appointments={appointments} onSelect={setSelected} />}
      </div>

      {selected && <DetailPanel appointment={selected} onClose={() => setSelected(null)} />}
    </main>
  )
}

function SummaryCard({ icon, label, value, detail, tone = 'default' }: { icon: ReactNode; label: string; value: number; detail: string; tone?: 'default' | 'warning' }) {
  return <div className="rounded-2xl border border-border bg-card p-4 shadow-sm"><div className="flex items-center justify-between"><span className="flex size-9 items-center justify-center rounded-xl bg-muted text-primary">{icon}</span><span className="text-3xl font-semibold tracking-tight">{value}</span></div><p className="mt-4 text-sm font-semibold">{label}</p><p className={`mt-1 text-xs ${tone === 'warning' ? 'text-destructive' : 'text-muted-foreground'}`}>{detail}</p></div>
}

function Appointments({ appointments, onSelect }: { appointments: DashboardAppointment[]; onSelect: (appointment: DashboardAppointment) => void }) {
  return <section aria-label="Afspraken" className="space-y-3">{appointments.map((appointment) => <AppointmentCard key={appointment.id} appointment={appointment} onSelect={() => onSelect(appointment)} />)}</section>
}

function AppointmentCard({ appointment, onSelect }: { appointment: DashboardAppointment; onSelect: () => void }) {
  const attention = !appointment.assigned || (appointment.missingRequired ?? 0) > 0
  return <article className={`group rounded-2xl border bg-card p-4 shadow-sm transition hover:border-primary/40 hover:shadow-md sm:p-5 ${attention ? 'border-chart-4/60' : 'border-border'}`}><div className="flex flex-col gap-4 sm:flex-row sm:items-start"><div className="flex shrink-0 items-center gap-2 text-sm font-semibold sm:w-28 sm:flex-col sm:items-start sm:gap-0.5"><span>{formatTime(appointment.start)}</span><span className="text-xs font-normal text-muted-foreground">{appointment.end ? `tot ${formatTime(appointment.end)}` : 'bezoekformulier'}</span></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="truncate text-base font-semibold">{appointment.customer}</h3>{!appointment.scheduled && <Badge icon={<AlertTriangle />} tone="warning">Niet gepland</Badge>}{!appointment.assigned && <Badge icon={<UserRound />} tone="warning">Niet toegewezen</Badge>}{appointment.visitId && <Badge icon={<CheckCircle2 />} tone={appointment.state === 'in_progress' ? 'info' : 'neutral'}>{stateLabel(appointment.state)}</Badge>}</div><p className="mt-1 truncate text-sm text-muted-foreground">{appointment.title}</p><div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1.5"><MapPin className="size-3.5" />{appointment.address}</span><span className="inline-flex items-center gap-1.5"><UsersRound className="size-3.5" />{appointment.people.length ? appointment.people.join(', ') : 'Geen monteur'}</span><span className="inline-flex items-center gap-1.5"><Wrench className="size-3.5" />{appointment.role}</span></div></div><button type="button" onClick={onSelect} className="inline-flex h-9 shrink-0 items-center justify-center gap-1 rounded-xl border border-border px-3 text-sm font-semibold transition hover:bg-muted">Details<ChevronRight className="size-4" /></button></div>{(appointment.missingRequired !== null || appointment.photoCount !== null) && <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3 text-xs"><Metric icon={<AlertTriangle />} label="Ontbrekend verplicht" value={appointment.missingRequired ?? 0} danger={(appointment.missingRequired ?? 0) > 0} /><Metric icon={<ImageIcon />} label="Foto's" value={appointment.photoCount ?? 0} /><Metric icon={<RouteIcon />} label="Reistijd" value={appointment.travelTimesUpToDate ? `${(appointment.travelTimeIn ?? 0) + (appointment.travelTimeOut ?? 0)} min` : 'Niet beschikbaar'} /></div>}</article>
}

function Metric({ icon, label, value, danger = false }: { icon: ReactNode; label: string; value: string | number; danger?: boolean }) { return <span className={`inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 ${danger ? 'text-destructive' : 'text-muted-foreground'}`}><span className="size-3.5">{icon}</span><span>{label}: <strong className="font-semibold">{value}</strong></span></span> }
function Badge({ children, icon, tone }: { children: ReactNode; icon: ReactNode; tone: 'warning' | 'info' | 'neutral' }) { return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${tone === 'warning' ? 'bg-chart-4/20 text-foreground' : tone === 'info' ? 'bg-chart-2/20 text-foreground' : 'bg-muted text-muted-foreground'}`}><span className="size-3">{icon}</span>{children}</span> }

function DetailPanel({ appointment, onClose }: { appointment: DashboardAppointment; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex justify-end bg-foreground/20" role="dialog" aria-modal="true" aria-label={`Details ${appointment.customer}`} onClick={onClose}><aside className="h-full w-full max-w-lg overflow-y-auto border-l border-border bg-card p-5 shadow-2xl sm:p-7" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Afspraakdetails</p><h2 className="mt-2 text-2xl font-semibold">{appointment.customer}</h2><p className="mt-1 text-sm text-muted-foreground">{appointment.title}</p></div><button type="button" onClick={onClose} aria-label="Sluiten" className="rounded-xl p-2 text-muted-foreground hover:bg-muted"><X className="size-5" /></button></div><div className="mt-7 grid gap-3 sm:grid-cols-2"><Detail label="Datum" value={formatDate(appointment.visitDate)} icon={<CalendarDays />} /><Detail label="Tijd" value={appointment.start ? `${formatTime(appointment.start)} – ${formatTime(appointment.end)}` : 'Niet gepland'} icon={<Clock3 />} /><Detail label="Adres" value={appointment.address} icon={<MapPin />} /><Detail label="Rol" value={appointment.role} icon={<Wrench />} /><Detail label="Toegewezen" value={appointment.people.length ? appointment.people.join(', ') : 'Niemand'} icon={<UsersRound />} /><Detail label="Status" value={stateLabel(appointment.state)} icon={<CheckCircle2 />} /></div><div className="mt-6 rounded-2xl bg-muted p-4"><p className="text-sm font-semibold">DIG-bezoekformulier</p><div className="mt-3 grid grid-cols-2 gap-3 text-sm"><div><p className="text-xs text-muted-foreground">Ontbrekende verplichte onderdelen</p><p className="mt-1 text-lg font-semibold">{appointment.missingRequired ?? 'Niet beschikbaar'}</p></div><div><p className="text-xs text-muted-foreground">Foto's vastgelegd</p><p className="mt-1 text-lg font-semibold">{appointment.photoCount ?? 'Niet beschikbaar'}</p></div></div>{appointment.missingInputs !== null && <p className="mt-3 text-xs text-muted-foreground">Ontbrekende verplichte invoervelden: {appointment.missingInputs}</p>}</div>{appointment.travelTimesUpToDate && <div className="mt-4 rounded-2xl border border-border p-4"><p className="text-sm font-semibold">Beschikbare reistijd</p><p className="mt-1 text-sm text-muted-foreground">Heen {appointment.travelTimeIn ?? 0} min · terug {appointment.travelTimeOut ?? 0} min</p></div>}{appointment.odooUrl && <a href={appointment.odooUrl} target="_blank" rel="noreferrer" className="mt-6 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:opacity-90">Open bestaand bezoekformulier in Odoo<ArrowUpRight className="size-4" /></a>}<p className="mt-4 text-center text-xs leading-5 text-muted-foreground">Dit dashboard wijzigt het bezoekformulier niet.</p></aside></div>
}

function Detail({ label, value, icon }: { label: string; value: string; icon: ReactNode }) { return <div className="rounded-xl border border-border p-3"><div className="flex items-center gap-2 text-xs text-muted-foreground"><span className="text-primary">{icon}</span>{label}</div><p className="mt-2 text-sm font-semibold leading-5">{value}</p></div> }
function stateLabel(state: string) { const labels: Record<string, string> = { in_progress: 'In uitvoering', done: 'Afgerond', draft: 'Concept', '1_draft': 'Concept', '2_confirmed': 'Bevestigd' }; return labels[state] ?? state.replaceAll('_', ' ') }
function LoadingState() { return <div className="rounded-2xl border border-border bg-card p-10 text-center shadow-sm"><RefreshCw className="mx-auto size-6 animate-spin text-primary" /><p className="mt-4 text-sm font-semibold">Odoo-afspraken laden</p><p className="mt-1 text-sm text-muted-foreground">De planning en DIG-bezoekformulieren worden opgehaald.</p></div> }
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="rounded-2xl border border-destructive/40 bg-card p-8 text-center shadow-sm"><AlertTriangle className="mx-auto size-7 text-destructive" /><p className="mt-4 text-sm font-semibold">Odoo-data kon niet worden geladen</p><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{message}</p><button type="button" onClick={onRetry} className="mt-5 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Opnieuw proberen</button></div> }
function EmptyState({ date, scope, onUpcoming, onAll }: { date: string; scope: DashboardResponse['scope']; onUpcoming: () => void; onAll: () => void }) { return <div className="rounded-2xl border border-dashed border-border bg-card px-6 py-14 text-center shadow-sm"><div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-muted text-primary"><CalendarDays className="size-7" /></div><h3 className="mt-5 text-xl font-semibold">Geen afspraken in deze weergave</h3><p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">Er zijn geen Odoo-records gevonden voor {scope === 'day' ? formatDate(date) : scope === 'upcoming' ? 'de komende periode' : 'de gekozen selectie'}. Er is niets verzonnen.</p><div className="mt-6 flex flex-wrap justify-center gap-2"><button type="button" onClick={onUpcoming} className="rounded-xl border border-border px-4 py-2 text-sm font-semibold hover:bg-muted">Bekijk komende afspraken</button><button type="button" onClick={onAll} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Bekijk alle afspraken</button></div></div> }
