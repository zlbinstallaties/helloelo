import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { AlertTriangle, CheckCircle2, KeyRound, Tags, Trash2, UserPlus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { AppHeader } from '@/components/app-header'
import { OneTimeSecret } from '@/components/one-time-secret'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ApiError, api } from '#/lib/api-client'
import type { AccountRow, AccountsResponse, PlanningRole, TechnicianCreated, TechnicianRoles, TechnicianRolesSaved } from '#/lib/admin-types'
import { newRequestId } from '#/lib/request-id'
import { useMe } from '#/lib/session'
import { suggestUsername } from '#/lib/username'

export const Route = createFileRoute('/beheer')({ component: Beheer })

const ACCOUNTS_KEY = ['accounts']
const ROLES_KEY = ['planning-roles']
const select =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm outline-none focus-visible:ring-1 focus-visible:ring-ring'

type Secret = { title: string; password: string }

/** `employee:41` in words, for a person that is not (yet) in the planning, so without a name. */
function describePerson(personId: string) {
  const [kind, id] = personId.split(':')
  if (kind === 'employee') return `Odoo-medewerker ${id}`
  if (kind === 'user') return `Odoo-gebruiker ${id}`
  return personId.replace(/^name:/, '')
}

/** A technician account that hangs on an employee of Odoo: only those have planning roles to change here. */
const isOdooTechnician = (account: AccountRow) => account.role === 'monteur' && /^employee:[1-9][0-9]*$/.test(account.personId ?? '')

function Beheer() {
  const me = useMe()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [secret, setSecret] = useState<Secret | null>(null)

  useEffect(() => {
    if (me.data && me.data.authMode === 'on' && !me.data.user) void navigate({ to: '/login' })
  }, [me.data, navigate])

  const allowed = me.data?.canManageAccounts === true
  const accounts = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: () => api<AccountsResponse>('/api/accounts', { fallback: 'De accounts konden niet worden geladen.' }),
    enabled: allowed,
  })
  const refreshAccounts = () => queryClient.invalidateQueries({ queryKey: ACCOUNTS_KEY })

  return (
    <main className="min-h-screen bg-background">
      <AppHeader me={me.data} active="beheer" />
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6">
        {me.data && !allowed && me.data.user && (
          <Alert variant="destructive">
            <AlertTitle>Geen toegang</AlertTitle>
            <AlertDescription>Alleen de planner kan accounts beheren en monteurs toevoegen.</AlertDescription>
          </Alert>
        )}
        {me.data?.authMode === 'off' && (
          <Alert>
            <AlertTitle>Geen accounts op deze server</AlertTitle>
            <AlertDescription>Inloggen staat hier uit, dus er zijn geen accounts om te beheren.</AlertDescription>
          </Alert>
        )}

        {allowed && (
          <>
            {secret && (
              <Card>
                <CardHeader>
                  <CardTitle>{secret.title}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <OneTimeSecret label="Wachtwoord" secret={secret.password} />
                  <Button type="button" variant="outline" size="sm" onClick={() => setSecret(null)}>Gelezen, sluiten</Button>
                </CardContent>
              </Card>
            )}

            <AddTechnician onCreated={() => void refreshAccounts()} />

            {accounts.isError && (
              <Alert variant="destructive">
                <AlertTitle>De accounts konden niet worden geladen</AlertTitle>
                <AlertDescription>{accounts.error.message}</AlertDescription>
              </Alert>
            )}
            {accounts.data?.planningError && (
              <Alert>
                <AlertTriangle className="size-4" />
                <AlertTitle>De Odoo-planning kon niet worden gelezen</AlertTitle>
                <AlertDescription>{accounts.data.planningError} Daardoor kun je nu geen bestaande persoon uit de planning koppelen.</AlertDescription>
              </Alert>
            )}

            {accounts.data && (
              <>
                <AccountsTable data={accounts.data} onChanged={() => void refreshAccounts()} onSecret={setSecret} />
                <LinkExisting data={accounts.data} onCreated={(created) => { setSecret(created); void refreshAccounts() }} />
              </>
            )}
          </>
        )}
      </div>
    </main>
  )
}

/* ---------------------------------------------------------------- Planningsrollen kiezen */

const MAX_ROLES = 5

/** The tick boxes for the planning roles of Odoo. The order of ticking is kept: the first one is the default role. */
function RoleCheckboxes({ roles, chosen, onChange, idPrefix }: { roles: PlanningRole[]; chosen: number[]; onChange: (chosen: number[]) => void; idPrefix: string }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      {roles.map((role) => (
        <div key={role.id} className="flex items-center gap-2">
          <Checkbox
            id={`${idPrefix}-${role.id}`}
            checked={chosen.includes(role.id)}
            disabled={!chosen.includes(role.id) && chosen.length >= MAX_ROLES}
            onCheckedChange={(checked) => onChange(checked === true ? (chosen.includes(role.id) ? chosen : [...chosen, role.id]) : chosen.filter((id) => id !== role.id))}
          />
          <Label htmlFor={`${idPrefix}-${role.id}`} className="font-normal">
            {role.name}
            {chosen[0] === role.id && chosen.length > 1 && <span className="ml-1 text-xs text-muted-foreground">(standaard)</span>}
          </Label>
        </div>
      ))}
    </div>
  )
}

/* ---------------------------------------------------------------- Monteur toevoegen */

function AddTechnician({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [usernameEdited, setUsernameEdited] = useState(false)
  // One id for one request: kept for every retry, so that the server can tell a repeat from a new request.
  const [requestId, setRequestId] = useState(() => newRequestId())
  const [done, setDone] = useState<TechnicianCreated | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  // The planning roles of Odoo, in the order the planner ticked them: the first one is the default role.
  const [chosen, setChosen] = useState<number[]>([])
  const roles = useQuery({
    queryKey: ROLES_KEY,
    queryFn: () => api<{ roles: PlanningRole[] }>('/api/planning-roles', { fallback: 'De planningsrollen konden niet uit Odoo worden gelezen.' }),
    retry: false,
  })
  const roleName = (id: number) => roles.data?.roles.find((role) => role.id === id)?.name ?? `rol ${id}`

  const create = useMutation({
    mutationFn: () =>
      api<TechnicianCreated>('/api/employees', {
        method: 'POST',
        body: { requestId, name, username, ...(chosen.length > 0 && { planningRoleIds: chosen }) },
        fallback: 'Het toevoegen is niet gelukt.',
      }),
    onSuccess: (data) => {
      setDone(data)
      setBlocked(null)
      onCreated()
    },
    onError: (error) => {
      // Not known what Odoo did: this request is never sent again, only a new one after looking in Odoo.
      setBlocked(error instanceof ApiError && error.data.retry === 'blocked' ? error.message : null)
      if (error instanceof ApiError && error.data.employeeId !== undefined) onCreated()
    },
  })

  function changeName(value: string) {
    setName(value)
    if (!usernameEdited) setUsername(suggestUsername(value))
  }

  function startOver() {
    setName('')
    setUsername('')
    setUsernameEdited(false)
    setChosen([])
    setDone(null)
    setBlocked(null)
    create.reset()
    setRequestId(newRequestId())
    void roles.refetch()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!create.isPending && !blocked) create.mutate()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><UserPlus className="size-5" /> Monteur toevoegen</CardTitle>
        <CardDescription>
          De monteur wordt in Odoo aangemaakt als medewerker, zodat je hem in Odoo Planning kunt inplannen, en krijgt een eigen account voor dit
          dashboard. Er komt geen Odoo-account en het dashboard plant niets in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {done ? (
          <div className="space-y-4">
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertTitle>{done.replayed ? 'Deze aanvraag was al verwerkt' : 'Monteur toegevoegd'}</AlertTitle>
              <AlertDescription>
                In Odoo staat de medewerker met nummer <strong>{done.employeeId}</strong>
                {done.account && <> en het account <strong>{done.account.username}</strong> is gekoppeld aan dat nummer</>}.
                {chosen.length > 0 && done.planningRoles === chosen.length && (
                  <> Hij heeft in Odoo {chosen.length === 1 ? 'de planningsrol' : 'de planningsrollen'} <strong>{chosen.map(roleName).join(', ')}</strong> en is te kiezen bij een dienst met {chosen.length === 1 ? 'die rol' : 'zo\'n rol'}.</>
                )}
              </AlertDescription>
            </Alert>
            {chosen.length === 0 && (
              <Alert>
                <AlertTriangle className="size-4" />
                <AlertTitle>Nog geen planningsrol</AlertTitle>
                <AlertDescription>
                  Een dienst met een rol kun je alleen toewijzen aan iemand die die rol heeft. Geef de monteur een rol met de knop Planningsrollen bij Accounts hieronder, of in Odoo (Werknemers, veld Functies (Roles)).
                </AlertDescription>
              </Alert>
            )}
            {chosen.length > 0 && done.planningRoles < chosen.length && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertTitle>Niet alle planningsrollen bevestigd</AlertTitle>
                <AlertDescription>
                  Je koos {chosen.length} {chosen.length === 1 ? 'rol' : 'rollen'}, Odoo bevestigde er {done.planningRoles}. Open de medewerker in Odoo (Werknemers, veld Functies (Roles)) en controleer of de rol er staat.
                </AlertDescription>
              </Alert>
            )}
            {!done.verified && (
              <Alert variant="destructive">
                <AlertTriangle className="size-4" />
                <AlertTitle>Niet gecontroleerd</AlertTitle>
                <AlertDescription>
                  Odoo bevestigde de medewerker, maar het terugkijken is niet gelukt. Open de medewerker in Odoo en controleer dat er geen Odoo-gebruiker aan gekoppeld is.
                </AlertDescription>
              </Alert>
            )}
            {done.password ? (
              <OneTimeSecret label={`Wachtwoord voor ${done.account?.username ?? 'de monteur'}`} secret={done.password} />
            ) : (
              <p className="text-sm text-muted-foreground">Het wachtwoord was al eerder getoond. Maak zo nodig een nieuw wachtwoord bij de accounts hieronder.</p>
            )}
            <Button type="button" onClick={startOver}>Nog een monteur toevoegen</Button>
          </div>
        ) : (
          <form onSubmit={submit} className="grid gap-4 md:grid-cols-2" noValidate>
            <div className="grid gap-1.5">
              <Label htmlFor="technician-name">Naam van de monteur</Label>
              <Input id="technician-name" value={name} onChange={(event) => changeName(event.target.value)} maxLength={80} disabled={Boolean(blocked)} required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="technician-username">Gebruikersnaam voor het dashboard</Label>
              <Input
                id="technician-username"
                value={username}
                onChange={(event) => { setUsername(event.target.value); setUsernameEdited(true) }}
                autoCapitalize="none"
                autoCorrect="off"
                maxLength={40}
                disabled={Boolean(blocked)}
                required
              />
              <p className="text-xs text-muted-foreground">3 tot 40 tekens: letters, cijfers, punt, streepje of underscore.</p>
            </div>

            <fieldset className="grid gap-2 md:col-span-2" disabled={Boolean(blocked)}>
              <legend className="text-sm font-medium">Planningsrollen (functies uit Odoo)</legend>
              {roles.isPending && <p className="text-sm text-muted-foreground">Rollen uit Odoo laden…</p>}
              {roles.isError && (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>De rollen konden niet worden gelezen</AlertTitle>
                  <AlertDescription className="space-y-2">
                    <p>{roles.error.message}</p>
                    <Button type="button" variant="outline" size="sm" onClick={() => void roles.refetch()}>Opnieuw proberen</Button>
                  </AlertDescription>
                </Alert>
              )}
              {roles.data && roles.data.roles.length === 0 && (
                <p className="text-sm text-muted-foreground">Er zijn nog geen planningsrollen in Odoo. Maak ze aan in Odoo bij Planning, Configuratie, Rollen en vernieuw deze pagina.</p>
              )}
              {roles.data && roles.data.roles.length > 0 && <RoleCheckboxes roles={roles.data.roles} chosen={chosen} onChange={setChosen} idPrefix="role" />}
              <p className="text-xs text-muted-foreground">
                Een dienst met een rol kun je alleen toewijzen aan iemand die die rol heeft. De eerste rol die je aanvinkt is de standaardrol (hoogstens 5).
                {chosen.length === 0 && ' Zonder rol kun je de monteur nog niet aan zo\'n dienst toewijzen.'}
              </p>
            </fieldset>

            {blocked && (
              <div className="md:col-span-2">
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>Niet zeker of de medewerker in Odoo is aangemaakt</AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p>{blocked}</p>
                    <p>
                      Zoek de naam in Odoo (Werknemers). Bestaat de medewerker, plan hem dan in Odoo in en koppel hieronder een account aan hem.
                      Bestaat hij niet, start dan een nieuwe aanvraag.
                    </p>
                    <Button type="button" variant="outline" size="sm" onClick={startOver}>Ik heb in Odoo gekeken: nieuwe aanvraag starten</Button>
                  </AlertDescription>
                </Alert>
              </div>
            )}
            {create.isError && !blocked && (
              <div className="md:col-span-2">
                <Alert variant="destructive">
                  <AlertTitle>Niet toegevoegd</AlertTitle>
                  <AlertDescription>
                    {create.error.message}
                    {create.error instanceof ApiError && create.error.data.employeeId !== undefined && (
                      <> Medewerker {String(create.error.data.employeeId)} bestaat al in Odoo; je kunt dezelfde gegevens opnieuw versturen om het account af te maken.</>
                    )}
                  </AlertDescription>
                </Alert>
              </div>
            )}

            <div className="md:col-span-2">
              <Button type="submit" disabled={create.isPending || Boolean(blocked) || !name.trim() || !username || chosen.length > 5}>
                <UserPlus className="size-4" /> {create.isPending ? 'Bezig met aanmaken in Odoo' : 'Monteur toevoegen'}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}

/* ---------------------------------------------------------------- Accounts */

function AccountsTable({ data, onChanged, onSecret }: { data: AccountsResponse; onChanged: () => void; onSecret: (secret: Secret) => void }) {
  const [problem, setProblem] = useState<string | null>(null)

  const toggle = useMutation({
    mutationFn: (account: AccountRow) =>
      api(`/api/accounts/${account.id}`, { method: 'PATCH', body: { disabled: !account.disabled }, fallback: 'Wijzigen is niet gelukt.' }),
    onSuccess: () => { setProblem(null); onChanged() },
    onError: (error) => setProblem(error.message),
  })
  const reset = useMutation({
    mutationFn: (account: AccountRow) => api<{ password: string }>(`/api/accounts/${account.id}/password`, { method: 'POST', fallback: 'Een nieuw wachtwoord maken is niet gelukt.' }),
    onSuccess: (result, account) => { setProblem(null); onSecret({ title: `Nieuw wachtwoord voor ${account.username}`, password: result.password }) },
    onError: (error) => setProblem(error.message),
  })
  const remove = useMutation({
    mutationFn: (account: AccountRow) => api(`/api/accounts/${account.id}`, { method: 'DELETE', fallback: 'Verwijderen is niet gelukt.' }),
    onSuccess: () => { setProblem(null); onChanged() },
    onError: (error) => setProblem(error.message),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Accounts</CardTitle>
        <CardDescription>Wie kan inloggen, en aan wie in de Odoo-planning een account gekoppeld is.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {problem && (
          <Alert variant="destructive">
            <AlertTitle>Niet gelukt</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Naam</TableHead>
              <TableHead>Gebruikersnaam</TableHead>
              <TableHead>Rol</TableHead>
              <TableHead>Gekoppeld aan</TableHead>
              <TableHead className="text-right">Acties</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.accounts.map((account) => {
              const own = account.id === data.currentUserId
              return (
                <TableRow key={account.id} className={account.disabled ? 'opacity-60' : undefined}>
                  <TableCell className="font-medium">
                    {account.name} {own && <span className="text-xs text-muted-foreground">(jij)</span>}
                    {account.disabled && <Badge variant="secondary" className="ml-2">Uitgeschakeld</Badge>}
                  </TableCell>
                  <TableCell>{account.username}</TableCell>
                  <TableCell>{account.role === 'admin' ? 'Planner' : 'Monteur'}</TableCell>
                  <TableCell>
                    {account.personId ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span>{account.personName ?? describePerson(account.personId)}</span>
                        {account.personInPlanning === false && <Badge variant="outline">Nog niet ingepland in Odoo</Badge>}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Ziet alles</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {!own && (
                      <div className="flex flex-wrap justify-end gap-2">
                        {isOdooTechnician(account) && <PlanningRolesDialog account={account} />}
                        <Button type="button" variant="outline" size="sm" onClick={() => reset.mutate(account)} disabled={reset.isPending}>
                          <KeyRound className="size-4" /> Nieuw wachtwoord
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => toggle.mutate(account)} disabled={toggle.isPending}>
                          {account.disabled ? 'Inschakelen' : 'Uitschakelen'}
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button type="button" variant="outline" size="sm"><Trash2 className="size-4" /> Verwijderen</Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Account van {account.name} verwijderen?</AlertDialogTitle>
                              <AlertDialogDescription>
                                Het account verdwijnt en de login stopt meteen. De medewerker in Odoo blijft bestaan; die verwijder je zo nodig in Odoo zelf.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Annuleren</AlertDialogCancel>
                              <AlertDialogAction onClick={() => remove.mutate(account)}>Verwijderen</AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

/* ---------------------------------------------------------------- Planningsrollen van een bestaande monteur wijzigen */

function PlanningRolesDialog({ account }: { account: AccountRow }) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm"><Tags className="size-4" /> Planningsrollen</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Planningsrollen van {account.name}</DialogTitle>
          <DialogDescription>
            De rollen staan in Odoo bij de medewerker (Werknemers, veld Functies (Roles)). Een dienst met een rol kun je alleen toewijzen aan iemand die die rol heeft.
          </DialogDescription>
        </DialogHeader>
        {/* Only mounted while open: every opening reads Odoo again, so what is shown is what Odoo has now. */}
        {open && <PlanningRolesBody account={account} onClose={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function PlanningRolesBody({ account, onClose }: { account: AccountRow; onClose: () => void }) {
  const roles = useQuery({
    queryKey: ROLES_KEY,
    queryFn: () => api<{ roles: PlanningRole[] }>('/api/planning-roles', { fallback: 'De planningsrollen konden niet uit Odoo worden gelezen.' }),
    retry: false,
  })
  const current = useQuery({
    queryKey: ['account-roles', account.id],
    queryFn: () => api<TechnicianRoles>(`/api/accounts/${account.id}/planning-roles`, { fallback: 'De rollen van deze monteur konden niet uit Odoo worden gelezen.' }),
    retry: false,
    gcTime: 0,
  })
  const problem = roles.isError ? roles.error.message : current.isError ? current.error.message : null
  const retry = () => { void roles.refetch(); void current.refetch() }

  if (problem) {
    return (
      <>
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>De rollen konden niet worden gelezen</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Sluiten</Button>
          <Button type="button" onClick={retry}>Opnieuw proberen</Button>
        </DialogFooter>
      </>
    )
  }
  if (!roles.data || !current.data) return <p className="text-sm text-muted-foreground">Rollen uit Odoo laden…</p>
  return <PlanningRolesForm account={account} roles={roles.data.roles} current={current.data} onClose={onClose} />
}

function PlanningRolesForm({ account, roles, current, onClose }: { account: AccountRow; roles: PlanningRole[]; current: TechnicianRoles; onClose: () => void }) {
  const selectable = new Set(roles.map((role) => role.id))
  // What Odoo has now, the default role first. A role that is no longer in the list (archived in Odoo) cannot be ticked here.
  const start = [
    ...(current.defaultPlanningRoleId !== null && current.planningRoleIds.includes(current.defaultPlanningRoleId) ? [current.defaultPlanningRoleId] : []),
    ...current.planningRoleIds.filter((id) => id !== current.defaultPlanningRoleId),
  ].filter((id) => selectable.has(id))
  const left = current.planningRoleIds.filter((id) => !selectable.has(id))
  const [chosen, setChosen] = useState<number[]>(start)
  const queryClient = useQueryClient()
  const name = (id: number) => roles.find((role) => role.id === id)?.name ?? `rol ${id}`

  const save = useMutation({
    mutationFn: () =>
      api<TechnicianRolesSaved>(`/api/accounts/${account.id}/planning-roles`, { method: 'PUT', body: { planningRoleIds: chosen }, fallback: 'Het wijzigen is niet gelukt.' }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['account-roles', account.id] }) },
  })
  const same = chosen.length === start.length && chosen.every((id, index) => id === start[index])

  if (save.isSuccess) {
    const confirmed = save.data.planningRoles === save.data.asked
    return (
      <>
        <Alert variant={confirmed ? 'default' : 'destructive'}>
          {confirmed ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
          <AlertTitle>{confirmed ? 'Planningsrollen gewijzigd' : 'Niet alle planningsrollen bevestigd'}</AlertTitle>
          <AlertDescription>
            {confirmed
              ? chosen.length === 0
                ? <>{account.name} heeft in Odoo nu geen planningsrol meer.</>
                : <>{account.name} heeft in Odoo nu {chosen.length === 1 ? 'de planningsrol' : 'de planningsrollen'} <strong>{chosen.map(name).join(', ')}</strong>.</>
              : <>Je koos {save.data.asked} {save.data.asked === 1 ? 'rol' : 'rollen'}, Odoo bevestigde er {save.data.planningRoles}. Open de medewerker in Odoo (Werknemers, veld Functies (Roles)) en controleer welke rollen er staan.</>}
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button type="button" onClick={onClose}>Sluiten</Button>
        </DialogFooter>
      </>
    )
  }

  return (
    <>
      <div className="space-y-3">
        {roles.length === 0 ? (
          <p className="text-sm text-muted-foreground">Er zijn nog geen planningsrollen in Odoo. Maak ze aan in Odoo bij Planning, Configuratie, Rollen en open dit scherm opnieuw.</p>
        ) : (
          <RoleCheckboxes roles={roles} chosen={chosen} onChange={setChosen} idPrefix={`edit-role-${account.id}`} />
        )}
        <p className="text-xs text-muted-foreground">
          De eerste rol die je aanvinkt is de standaardrol (hoogstens {MAX_ROLES}).
          {chosen.length === 0 && ' Zonder rol kun je de monteur niet aan een dienst met een rol toewijzen.'}
        </p>
        {left.length > 0 && (
          <Alert>
            <AlertTriangle className="size-4" />
            <AlertTitle>Rollen die hier niet te kiezen zijn</AlertTitle>
            <AlertDescription>
              In Odoo heeft hij ook {left.length === 1 ? 'rol' : 'rollen'} {left.join(', ')} (gearchiveerd of niet toegestaan). Bij opslaan {left.length === 1 ? 'verdwijnt die rol' : 'verdwijnen die rollen'} bij hem.
            </AlertDescription>
          </Alert>
        )}
        {save.isError && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>Niet gewijzigd</AlertTitle>
            <AlertDescription>{save.error.message}</AlertDescription>
          </Alert>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Annuleren</Button>
        <Button type="button" onClick={() => save.mutate()} disabled={save.isPending || same || chosen.length > MAX_ROLES}>
          {save.isPending ? 'Bezig met wijzigen in Odoo' : 'Opslaan in Odoo'}
        </Button>
      </DialogFooter>
    </>
  )
}

/* ---------------------------------------------------------------- Account voor een bestaande medewerker */

function LinkExisting({ data, onCreated }: { data: AccountsResponse; onCreated: (secret: Secret) => void }) {
  const free = data.persons.filter((person) => !person.hasAccount)
  const [mode, setMode] = useState<'monteur' | 'admin'>('monteur')
  const [personId, setPersonId] = useState('')
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [usernameEdited, setUsernameEdited] = useState(false)

  const create = useMutation({
    mutationFn: () =>
      api<{ account: AccountRow; password: string }>('/api/accounts', {
        method: 'POST',
        body: { username, name, role: mode, ...(mode === 'monteur' ? { personId } : {}) },
        fallback: 'Het account maken is niet gelukt.',
      }),
    onSuccess: (result) => {
      onCreated({ title: `Account ${result.account.username} gemaakt`, password: result.password })
      setPersonId('')
      setName('')
      setUsername('')
      setUsernameEdited(false)
    },
  })

  function choosePerson(value: string) {
    setPersonId(value)
    const person = data.persons.find((item) => item.value === value)
    if (person && !name) {
      const plain = person.label.replace(/\s*\(.*\)\s*$/, '')
      setName(plain)
      if (!usernameEdited) setUsername(suggestUsername(plain))
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!create.isPending) create.mutate()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account voor iemand die al in Odoo staat</CardTitle>
        <CardDescription>
          Kies een medewerker die al in de Odoo-planning voorkomt, of maak een extra planner-account. Hier wordt niets in Odoo aangemaakt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="grid gap-4 md:grid-cols-2" noValidate>
          <div className="grid gap-1.5 md:col-span-2">
            <Label htmlFor="link-mode">Soort account</Label>
            <select id="link-mode" className={select} value={mode} onChange={(event) => setMode(event.target.value as 'monteur' | 'admin')}>
              <option value="monteur">Monteur (ziet alleen zijn eigen afspraken)</option>
              <option value="admin">Planner (ziet alles en beheert accounts)</option>
            </select>
          </div>
          {mode === 'monteur' && (
            <div className="grid gap-1.5 md:col-span-2">
              <Label htmlFor="link-person">Medewerker uit de planning</Label>
              <select id="link-person" className={select} value={personId} onChange={(event) => choosePerson(event.target.value)} required>
                <option value="">{free.length ? 'Kies een medewerker' : 'Iedereen in de planning heeft al een account'}</option>
                {free.map((person) => <option key={person.value} value={person.value}>{person.label}</option>)}
              </select>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="link-name">Naam</Label>
            <Input id="link-name" value={name} maxLength={80} onChange={(event) => { setName(event.target.value); if (!usernameEdited) setUsername(suggestUsername(event.target.value)) }} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="link-username">Gebruikersnaam</Label>
            <Input id="link-username" value={username} maxLength={40} autoCapitalize="none" autoCorrect="off" onChange={(event) => { setUsername(event.target.value); setUsernameEdited(true) }} required />
          </div>
          {create.isError && (
            <div className="md:col-span-2">
              <Alert variant="destructive">
                <AlertTitle>Account niet gemaakt</AlertTitle>
                <AlertDescription>{create.error.message}</AlertDescription>
              </Alert>
            </div>
          )}
          <div className="md:col-span-2">
            <Button type="submit" disabled={create.isPending || !name.trim() || !username || (mode === 'monteur' && !personId)}>
              {create.isPending ? 'Bezig' : 'Account maken'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
