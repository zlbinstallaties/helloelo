import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Bot, CheckCircle2, FileText, LockKeyhole, LogOut, Plus, RefreshCw, ShieldAlert } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/builder')({ component: Builder })

type User = { uid: number; login: string; name: string }
type Project = { id: string; description: string; provider: string; model: string; state: string; proposal: string | null; created_at: string }

async function jsonRequest<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? 'De aanvraag is mislukt.')
  return payload as T
}

function Builder() {
  const queryClient = useQueryClient()
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [description, setDescription] = useState('')
  const [provider, setProvider] = useState('openai')
  const [model, setModel] = useState('')
  const [error, setError] = useState('')
  const session = useQuery({ queryKey: ['builder-session'], queryFn: () => jsonRequest<{ user: User }>('/api/auth/me'), retry: false })
  const projects = useQuery({ queryKey: ['builder-projects'], queryFn: () => jsonRequest<{ projects: Project[] }>('/api/builder'), enabled: Boolean(session.data), retry: false })
  const providers = useQuery({ queryKey: ['builder-providers'], queryFn: () => jsonRequest<{ providers: { provider: string; configured: boolean; model_configured: boolean }[] }>('/api/builder?action=providers'), enabled: Boolean(session.data), retry: false })

  async function signIn(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await jsonRequest('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password }) })
      setPassword('')
      await queryClient.invalidateQueries({ queryKey: ['builder-session'] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Aanmelden mislukt.')
    }
  }

  async function createProject(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await jsonRequest('/api/builder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', description, provider, model }) })
      setDescription('')
      await queryClient.invalidateQueries({ queryKey: ['builder-projects'] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Project aanmaken mislukt.')
    }
  }

  async function generateProposal(id: string) {
    setError('')
    try {
      await jsonRequest('/api/builder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'proposal', id }) })
      await queryClient.invalidateQueries({ queryKey: ['builder-projects'] })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Voorstelgeneratie mislukt.')
    }
  }

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' })
    await queryClient.invalidateQueries({ queryKey: ['builder-session'] })
    queryClient.removeQueries({ queryKey: ['builder-projects'] })
  }

  if (session.isLoading) return <main className="grid min-h-screen place-items-center bg-background text-sm text-muted-foreground">Builder-sessie controleren...</main>
  if (!session.data) return <Login login={login} password={password} error={error || (session.error?.message ?? '')} onLogin={setLogin} onPassword={setPassword} onSubmit={signIn} />

  return <main className="min-h-screen bg-background text-foreground"><header className="border-b border-border bg-card"><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-5 sm:px-6"><div className="flex items-center gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Bot className="size-5" /></span><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">DIG Builder</p><h1 className="text-xl font-semibold">Veilige uitbreidingen voor Odoo</h1></div></div><button type="button" onClick={signOut} className="inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-semibold hover:bg-muted"><LogOut className="size-4" />Afmelden</button></div></header><div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6"><section className="rounded-2xl border border-border bg-card p-5 shadow-sm"><div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start"><div><p className="text-sm text-muted-foreground">Aangemeld als {session.data.user.name}</p><h2 className="mt-1 text-2xl font-semibold">Wat wil je uitbreiden?</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Beschrijf de gewenste uitbreiding. De eerste stap maakt alleen een voorstel; er wordt geen code uitgevoerd of geïnstalleerd.</p></div><span className="inline-flex items-center gap-2 rounded-full bg-chart-2/15 px-3 py-2 text-xs font-semibold"><CheckCircle2 className="size-4" />Odoo-admin geverifieerd</span></div><form onSubmit={createProject} className="mt-5 grid gap-3"><textarea required value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Bijvoorbeeld: toon per planning-slot de openstaande DIG-controlepunten..." className="min-h-28 rounded-xl border border-input bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring" /><div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]"><select value={provider} onChange={(event) => setProvider(event.target.value)} className="h-10 rounded-xl border border-input bg-background px-3 text-sm"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select><input required value={model} onChange={(event) => setModel(event.target.value)} placeholder="Modelnaam" className="h-10 rounded-xl border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring" /><button type="submit" className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground"><Plus className="size-4" />Project starten</button></div></form></section><section className="grid gap-3 sm:grid-cols-2">{providers.data?.providers.map((item) => <div key={item.provider} className="rounded-2xl border border-border bg-card p-4"><div className="flex items-center justify-between"><span className="font-semibold capitalize">{item.provider}</span><span className={`text-xs font-semibold ${item.configured ? 'text-chart-2' : 'text-muted-foreground'}`}>{item.configured ? 'Geconfigureerd' : 'Niet geconfigureerd'}</span></div><p className="mt-2 text-xs text-muted-foreground">Model: {item.model_configured ? 'ingesteld' : 'ontbreekt'}</p></div>)}</section>{error && <div className="rounded-xl border border-destructive/40 bg-card p-4 text-sm text-destructive" role="alert">{error}</div>}<section><div className="mb-3 flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Werkruimte</p><h2 className="mt-1 text-2xl font-semibold">Projecten</h2></div><button type="button" onClick={() => projects.refetch()} className="rounded-xl border border-border p-2 hover:bg-muted" aria-label="Projecten verversen"><RefreshCw className="size-4" /></button></div>{projects.isLoading ? <div className="rounded-2xl border border-border bg-card p-8 text-sm text-muted-foreground">Projecten laden...</div> : <div className="grid gap-3">{projects.data?.projects.map((project) => <article key={project.id} className="rounded-2xl border border-border bg-card p-5 shadow-sm"><div className="flex flex-col justify-between gap-3 sm:flex-row"><div><span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold">{project.state}</span><h3 className="mt-3 font-semibold">{project.description}</h3><p className="mt-1 text-xs text-muted-foreground">{project.provider} · {project.model}</p></div>{project.state === 'draft' && <button type="button" onClick={() => generateProposal(project.id)} className="inline-flex h-9 items-center justify-center gap-2 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground"><FileText className="size-4" />Voorstel maken</button>}</div>{project.proposal && <div className="mt-4 whitespace-pre-wrap rounded-xl bg-muted p-4 text-sm leading-6">{project.proposal}</div>}</article>)}{projects.data?.projects.length === 0 && <div className="rounded-2xl border border-dashed border-border bg-card p-10 text-center text-sm text-muted-foreground">Nog geen builder-projecten.</div>}</div>}</section><p className="flex items-center gap-2 text-xs text-muted-foreground"><LockKeyhole className="size-3.5" />Voorstellen zijn informatief. Goedkeuring, bouwen, testen en installeren blijven afzonderlijke stappen.</p></div></main>
}

function Login({ login, password, error, onLogin, onPassword, onSubmit }: { login: string; password: string; error: string; onLogin: (value: string) => void; onPassword: (value: string) => void; onSubmit: (event: React.FormEvent) => void }) {
  return <main className="grid min-h-screen place-items-center bg-background px-4"><form onSubmit={onSubmit} className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-sm"><div className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground"><LockKeyhole className="size-5" /></div><p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-primary">DIG Builder</p><h1 className="mt-2 text-2xl font-semibold">Aanmelden met Odoo</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">Alleen gebruikers met de groep DIG Builder Administrator krijgen toegang.</p><div className="mt-6 grid gap-3"><label className="grid gap-1.5 text-sm font-medium">Odoo-login<input required value={login} onChange={(event) => onLogin(event.target.value)} autoComplete="username" className="h-10 rounded-xl border border-input bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring" /></label><label className="grid gap-1.5 text-sm font-medium">Wachtwoord<input required type="password" value={password} onChange={(event) => onPassword(event.target.value)} autoComplete="current-password" className="h-10 rounded-xl border border-input bg-background px-3 font-normal outline-none focus:ring-2 focus:ring-ring" /></label><button type="submit" className="mt-2 h-10 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground">Aanmelden</button></div>{error && <p className="mt-4 flex items-center gap-2 text-sm text-destructive" role="alert"><ShieldAlert className="size-4" />{error}</p>}</form></main>
}
