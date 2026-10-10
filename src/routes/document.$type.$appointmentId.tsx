import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { AppHeader } from '@/components/app-header'
import { DocumentForm } from '@/components/documents/document-form'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { ApiError } from '#/lib/api-client'
import { dashboardParams, requestDashboard } from '#/lib/dashboard-client'
import { FORMS, isDocumentType } from '#/lib/documents/forms'
import { useMe } from '#/lib/session'

// /document/schouw/slot-12: fill in a schouw or oplever document for one appointment, on the phone.
// What goes where is in src/components/documents/document-form.tsx; the server side is src/lib/document-handlers.ts.
export const Route = createFileRoute('/document/$type/$appointmentId')({ component: DocumentPage })

function DocumentPage() {
  const { type, appointmentId } = Route.useParams()
  const me = useMe()
  const navigate = useNavigate()
  const user = me.data?.user ?? null
  const form = isDocumentType(type) ? FORMS[type] : null

  useEffect(() => {
    if (me.data && me.data.authMode === 'on' && !me.data.user) void navigate({ to: '/login' })
  }, [me.data, navigate])

  // The appointment comes from the same list as the dashboard, so a technician can only open his own.
  const appointments = useQuery({
    queryKey: ['dig-dashboard', 'document', appointmentId],
    queryFn: () => requestDashboard(dashboardParams('', 'all', ''), 'GET', 'De afspraak kon niet worden geladen.'),
    enabled: user !== null && form !== null,
    staleTime: 60_000,
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
  })
  const appointment = appointments.data?.appointments.find((item) => item.id === appointmentId) ?? null

  return (
    <main className="min-h-screen bg-background">
      <AppHeader me={me.data} active="dashboard" />
      <div className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
        {me.data?.authMode === 'off' && (
          <Alert>
            <AlertTitle>Geen accounts op deze server</AlertTitle>
            <AlertDescription>Inloggen staat hier uit, dus documenten versturen kan hier niet.</AlertDescription>
          </Alert>
        )}
        {!form && (
          <Alert variant="destructive">
            <AlertTitle>Dit soort document bestaat niet</AlertTitle>
            <AlertDescription>
              Kies een afspraak in het overzicht en dan Schouw invullen of Oplevering invullen. <Link to="/" className="underline">Naar de afspraken</Link>
            </AlertDescription>
          </Alert>
        )}
        {form && user && appointments.isPending && <p className="text-sm text-muted-foreground" role="status">Afspraak laden…</p>}
        {form && user && appointments.isError && (
          <Alert variant="destructive">
            <AlertTitle>De afspraak kon niet worden geladen</AlertTitle>
            <AlertDescription>{appointments.error.message}</AlertDescription>
          </Alert>
        )}
        {form && user && appointments.data && !appointment && (
          <Alert variant="destructive">
            <AlertTitle>Afspraak niet gevonden</AlertTitle>
            <AlertDescription>
              Deze afspraak staat niet (meer) in jouw overzicht. <Link to="/" className="underline">Naar de afspraken</Link>
            </AlertDescription>
          </Alert>
        )}
        {form && user && appointment && <DocumentForm key={`${form.type}-${appointment.id}`} form={form} appointment={appointment} user={user} />}
      </div>
    </main>
  )
}
