import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { LogOut, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '#/lib/api-client'
import type { Me } from '#/lib/session'

type Page = 'dashboard' | 'availability' | 'beheer' | 'account'

const link = (active: boolean) =>
  `rounded-lg px-3 py-1.5 text-sm font-medium transition ${active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`

/** The top of every page: the name of the app, where to go, who is logged in and how to log out. */
export function AppHeader({ me, active }: { me: Me | undefined; active: Page }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const logout = useMutation({
    mutationFn: () => api('/api/auth/logout', { method: 'POST', fallback: 'Uitloggen is niet gelukt.' }),
    onSettled: async () => {
      // Nothing of this person stays in the browser for the next one.
      queryClient.clear()
      await navigate({ to: '/login' })
    },
  })
  const user = me?.user ?? null

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Wrench className="size-5" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">DIG · Odoo 20</p>
            <h1 className="text-xl font-semibold tracking-tight">Monteursdashboard</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {user && (
            <nav className="flex items-center gap-1" aria-label="Pagina's">
              <Link to="/" className={link(active === 'dashboard')}>Afspraken</Link>
              <Link to="/beschikbaarheid" className={link(active === 'availability')}>Beschikbaarheid</Link>
              {me?.canManageAccounts && <Link to="/beheer" className={link(active === 'beheer')}>Beheer</Link>}
              <Link to="/account" className={link(active === 'account')}>Account</Link>
            </nav>
          )}
          {user ? (
            <div className="flex items-center gap-2">
              <span className="hidden text-sm text-muted-foreground sm:inline">
                {user.name} · {user.role === 'admin' ? 'planner' : 'monteur'}
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
                <LogOut className="size-4" /> Uitloggen
              </Button>
            </div>
          ) : (
            me?.authMode === 'off' && (
              <div className="hidden items-center gap-2 rounded-full border border-border bg-muted px-3 py-2 text-xs font-medium text-muted-foreground sm:flex">
                <span className="size-2 rounded-full bg-chart-2" /> Alleen-lezen · testomgeving
              </div>
            )
          )}
        </div>
      </div>
    </header>
  )
}
