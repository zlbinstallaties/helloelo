import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, Camera, CheckCircle2, ImagePlus, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SignaturePad } from '@/components/documents/signature-pad'
import { api, ApiError } from '#/lib/api-client'
import type { DashboardAppointment } from '#/lib/dashboard-types'
import { deleteDraft, indexedDbDraftStorage, loadDraft, purgeOldDrafts, saveDraft } from '#/lib/documents/draft-store'
import {
  addPhoto, canAddPhoto, draftKey, emptyDraft, firstErrorId, newSubmissionId, removePhoto, setNote, setSignatureImage, setSignatureName, setText, setYesNo, toPayload,
  validateDraft,
} from '#/lib/documents/form-state'
import type { Draft } from '#/lib/documents/form-state'
import { YES_NO_LABELS } from '#/lib/documents/forms'
import type { FieldDef, FormDef, PhotosField, YesNo, YesNoField } from '#/lib/documents/forms'
import { PhotoError, shrinkPhoto } from '#/lib/documents/photo-browser'
import type { SessionUser } from '#/lib/session'

/*
 * The form on the phone: big buttons, the camera, the signature of the customer, and a draft that is kept on the phone
 * (photos included) until the document has been sent. What is wrong is pointed at per field, and the phone jumps to the
 * first one. The server checks everything again; what the phone does here is help, not trust.
 */

const RING = 'focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
const CONTROL = `h-12 text-base ${RING}`
const domId = (id: string) => `f-${id.replace(/\./g, '-')}`

type Posted = { ok: true; state: 'posted'; noted: boolean; customer: string | null; replayed: boolean }
/** What happened to the last try to send. `retry`: nothing was placed, so the same document may be sent again. */
type Problem = { kind: 'failed'; message: string; retry: boolean } | { kind: 'unknown'; message: string } | { kind: 'offline'; message: string }

function focusField(id: string) {
  const element = document.getElementById(domId(id))
  if (!element) return
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' })
  element.focus({ preventScroll: true })
}

/* ---------------------------------------------------------------- one field */

function Field({ field, error, children }: { field: FieldDef; error?: string; children: (a11y: { id: string; invalid: boolean; describedBy?: string }) => ReactNode }) {
  const id = domId(field.id)
  const describedBy = [field.help && `${id}-help`, error && `${id}-error`].filter(Boolean).join(' ') || undefined
  const composite = field.kind === 'yesno' || field.kind === 'photos'
  return (
    <div className="grid gap-2">
      {composite ? (
        <p id={`${id}-label`} className="text-base font-medium leading-snug">
          {field.label}
          {!field.required && <span className="font-normal text-muted-foreground"> (niet verplicht)</span>}
        </p>
      ) : (
        <Label htmlFor={id} className="text-base leading-snug">
          {field.label}
          {!field.required && <span className="font-normal text-muted-foreground"> (niet verplicht)</span>}
        </Label>
      )}
      {field.help && <p id={`${id}-help`} className="text-sm text-muted-foreground">{field.help}</p>}
      {children({ id, invalid: Boolean(error), describedBy })}
      {error && (
        <p id={`${id}-error`} className="flex items-start gap-1.5 text-sm font-medium text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  )
}

function YesNoControl({ field, draft, a11y, onChoose, onNote }: { field: YesNoField; draft: Draft; a11y: { id: string; invalid: boolean; describedBy?: string }; onChoose: (value: YesNo) => void; onNote: (note: string) => void }) {
  const answer = draft.answers[field.id]
  const current = typeof answer === 'object' && !Array.isArray(answer) ? answer : { value: '', note: '' }
  const options: YesNo[] = field.allowNa ? ['ja', 'nee', 'nvt'] : ['ja', 'nee']
  const explain = field.explainWhen !== undefined && current.value === field.explainWhen
  return (
    <div className="grid gap-3">
      <div
        id={a11y.id}
        tabIndex={-1}
        role="radiogroup"
        aria-labelledby={`${a11y.id}-label`}
        aria-invalid={a11y.invalid}
        aria-describedby={a11y.describedBy}
        className={`grid gap-2 rounded-lg outline-none focus:ring-[3px] focus:ring-ring focus:ring-offset-2 focus:ring-offset-background ${options.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}
      >
        {options.map((option) => (
          <label
            key={option}
            className="relative flex min-h-12 cursor-pointer select-none items-center justify-center rounded-lg border-2 border-input bg-card px-2 text-center text-base font-semibold leading-tight transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-primary-foreground has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background"
          >
            <input type="radio" name={field.id} value={option} checked={current.value === option} onChange={() => onChoose(option)} className="sr-only" />
            {option === 'nvt' ? 'N.v.t.' : YES_NO_LABELS[option]}
          </label>
        ))}
      </div>
      {explain && (
        <div className="grid gap-1.5">
          <Label htmlFor={`${a11y.id}-note`} className="text-base">Toelichting</Label>
          <Textarea id={`${a11y.id}-note`} value={current.note} onChange={(event) => onNote(event.target.value)} aria-invalid={a11y.invalid} aria-describedby={a11y.describedBy} className={`min-h-24 text-base ${RING}`} />
        </div>
      )}
    </div>
  )
}

function PhotosControl({ form, field, draft, a11y, onAdd, onRemove }: { form: FormDef; field: PhotosField; draft: Draft; a11y: { id: string; invalid: boolean; describedBy?: string }; onAdd: (photo: string) => void; onRemove: (index: number) => void }) {
  const photos = Array.isArray(draft.answers[field.id]) ? (draft.answers[field.id] as string[]) : []
  const camera = useRef<HTMLInputElement>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const room = canAddPhoto(form, draft, field)

  async function take(files: FileList | null) {
    if (!files || files.length === 0) return
    setProblem('')
    setBusy(true)
    let skipped = 0
    try {
      let free = field.max - photos.length
      for (const file of Array.from(files)) {
        if (free <= 0) {
          skipped++
          continue
        }
        try {
          onAdd(await shrinkPhoto(file))
          free--
        } catch (error) {
          setProblem(error instanceof PhotoError ? error.message : 'Deze foto kon niet worden verwerkt.')
        }
      }
      if (skipped > 0) setProblem(`Maximaal ${field.max} foto's: ${skipped} ${skipped === 1 ? 'foto is' : "foto's zijn"} niet toegevoegd.`)
    } finally {
      setBusy(false)
      if (camera.current) camera.current.value = ''
      if (gallery.current) gallery.current.value = ''
    }
  }

  return (
    <div id={a11y.id} tabIndex={-1} aria-describedby={a11y.describedBy} className="grid gap-3 rounded-lg outline-none focus:ring-[3px] focus:ring-ring focus:ring-offset-2 focus:ring-offset-background" role="group" aria-labelledby={`${a11y.id}-label`}>
      {photos.length > 0 && (
        <ul className="grid grid-cols-3 gap-2" aria-label={`${photos.length} van maximaal ${field.max} foto's`}>
          {photos.map((photo, index) => (
            <li key={`${index}-${photo.length}`} className="relative">
              <img src={photo} alt={`Foto ${index + 1} van ${photos.length}`} className="aspect-square w-full rounded-lg border border-border object-cover" />
              <button
                type="button"
                onClick={() => { setProblem(''); onRemove(index) }}
                aria-label={`Foto ${index + 1} verwijderen`}
                className={`absolute right-1 top-1 flex size-11 items-center justify-center rounded-full bg-card/95 text-destructive shadow ring-1 ring-border ${RING} outline-none`}
              >
                <Trash2 className="size-5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" className={`h-12 text-base ${RING}`} disabled={!room || busy} onClick={() => camera.current?.click()}>
          <Camera className="size-5" aria-hidden="true" /> Foto maken
        </Button>
        <Button type="button" variant="outline" className={`h-12 text-base ${RING}`} disabled={!room || busy} onClick={() => gallery.current?.click()}>
          <ImagePlus className="size-5" aria-hidden="true" /> Uit galerij
        </Button>
        <input ref={camera} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" data-testid={`${a11y.id}-camera`} onChange={(event) => void take(event.target.files)} />
        <input ref={gallery} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden="true" data-testid={`${a11y.id}-gallery`} onChange={(event) => void take(event.target.files)} />
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {busy ? "Foto's worden verwerkt…" : `${photos.length} van maximaal ${field.max} foto's.${!room && photos.length < field.max ? " Het maximum van het hele document is bereikt." : ''}`}
      </p>
      {problem && <p className="text-sm font-medium text-destructive" role="alert">{problem}</p>}
    </div>
  )
}

/* ---------------------------------------------------------------- the whole form */

export function DocumentForm({ form, appointment, user }: { form: FormDef; appointment: DashboardAppointment; user: SessionUser }) {
  const key = draftKey(user.id, form.type, appointment.id)
  const storage = useMemo(() => indexedDbDraftStorage(), [])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [restored, setRestored] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [kept, setKept] = useState<boolean | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [problem, setProblem] = useState<Problem | null>(null)
  const [posted, setPosted] = useState<Posted | null>(null)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [confirmResend, setConfirmResend] = useState(false)
  const latest = useRef<Draft | null>(null)
  latest.current = draft

  // The draft of an earlier visit comes back, photos and signature included.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const now = new Date()
      void purgeOldDrafts(storage, now)
      const saved = await loadDraft(storage, key, form, now)
      if (cancelled) return
      setRestored(saved !== null)
      setDraft(saved ?? emptyDraft(newSubmissionId(), now))
    })()
    return () => {
      cancelled = true
    }
  }, [storage, key, form])

  // Kept shortly after every change, and at once when the page is hidden: the phone may remove the tab from memory while the camera is open.
  useEffect(() => {
    if (!draft || !dirty || posted) return
    const timer = setTimeout(() => void saveDraft(storage, key, draft, new Date()).then(setKept), 500)
    return () => clearTimeout(timer)
  }, [draft, dirty, posted, storage, key])
  useEffect(() => {
    const flush = () => {
      if (latest.current && dirty && !posted) void saveDraft(storage, key, latest.current, new Date())
    }
    const hidden = () => document.visibilityState === 'hidden' && flush()
    document.addEventListener('visibilitychange', hidden)
    window.addEventListener('pagehide', flush)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      window.removeEventListener('pagehide', flush)
    }
  }, [dirty, posted, storage, key])

  const change = useCallback((fieldId: string | null, apply: (current: Draft) => Draft) => {
    setDraft((current) => (current ? apply(current) : current))
    setDirty(true)
    setProblem((now) => (now?.kind === 'unknown' ? now : null))
    if (fieldId) {
      setErrors((now) => {
        if (!(fieldId in now)) return now
        const { [fieldId]: _gone, ...rest } = now
        return rest
      })
    }
  }, [])

  const send = useMutation({
    mutationFn: (sending: Draft) => api<Posted>('/api/documents', { method: 'POST', body: toPayload(form, sending, appointment.id), fallback: 'Versturen is niet gelukt.' }),
    onSuccess: async (result) => {
      await deleteDraft(storage, key)
      setProblem(null)
      setPosted(result)
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return setProblem({ kind: 'failed', message: 'Versturen is niet gelukt.', retry: true })
      const fields = error.data.errors as Record<string, string> | undefined
      if (error.status === 422 && fields && typeof fields === 'object') {
        setErrors(fields)
        const first = firstErrorId(form, fields)
        if (first) setTimeout(() => focusField(first), 0)
        return setProblem({ kind: 'failed', message: 'Het formulier klopt nog niet. Controleer de gemarkeerde velden.', retry: true })
      }
      // No answer at all: the document may have arrived, but the number of this draft makes sending it again safe.
      if (error.status === 0) return setProblem({ kind: 'offline', message: 'Geen verbinding met de server. Je concept staat nog op deze telefoon; probeer het opnieuw zodra je weer bereik hebt.' })
      if (error.data.retry === false && (error.status === 504 || error.status === 409)) return setProblem({ kind: 'unknown', message: error.message })
      setProblem({ kind: 'failed', message: error.message, retry: error.data.retry !== false })
    },
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!draft || send.isPending) return
    const found = validateDraft(form, draft, user.name)
    setErrors(found)
    const first = firstErrorId(form, found)
    if (first) {
      setProblem(null)
      focusField(first)
      return
    }
    setProblem(null)
    send.mutate(draft)
  }

  /** The person has looked in Odoo and the document is not there: a new number makes it a new document. */
  function sendAsNew() {
    if (!draft) return
    const fresh: Draft = { ...draft, submissionId: newSubmissionId() }
    setDraft(fresh)
    setProblem(null)
    send.mutate(fresh)
  }

  async function startOver() {
    await deleteDraft(storage, key)
    setDraft(emptyDraft(newSubmissionId(), new Date()))
    setRestored(false)
    setDirty(false)
    setErrors({})
    setProblem(null)
  }

  const date = appointment.visitDate
    ? new Intl.DateTimeFormat('nl-NL', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${appointment.visitDate}T12:00:00Z`))
    : ''

  const header = (
    <div className="grid gap-3">
      <Link to="/" className={`inline-flex h-11 w-fit items-center gap-2 rounded-lg px-1 text-base font-medium text-muted-foreground outline-none hover:text-foreground ${RING}`}>
        <ArrowLeft className="size-5" aria-hidden="true" /> Afspraken
      </Link>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{form.title}</p>
        <h2 className="mt-1 text-2xl font-semibold leading-tight">{appointment.customer}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{[appointment.title, appointment.address, date].filter(Boolean).join(' · ')}</p>
        <p className="mt-1 text-sm text-muted-foreground">Ingevuld door {user.name}</p>
      </div>
    </div>
  )

  if (posted) {
    return (
      <div className="grid gap-6">
        {header}
        <Alert>
          <CheckCircle2 className="size-5" aria-hidden="true" />
          <AlertTitle data-testid="document-posted">{posted.replayed ? 'Dit document was al verstuurd' : 'Verstuurd'}</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>{posted.customer ? `Het ondertekende document staat nu bij ${posted.customer} in Odoo.` : 'Het ondertekende document staat bij de klant in Odoo.'}</span>
            {!posted.noted && <span>Let op: de melding in het logboek van de klant ontbreekt. Het bestand zelf staat wel bij de klant.</span>}
          </AlertDescription>
        </Alert>
        <Button asChild className={`h-12 text-base ${RING}`}>
          <Link to="/">Terug naar afspraken</Link>
        </Button>
      </div>
    )
  }

  if (!draft) {
    return (
      <div className="grid gap-6">
        {header}
        <p className="text-sm text-muted-foreground" role="status">Concept laden…</p>
      </div>
    )
  }

  const errorOf = (id: string) => errors[id]
  const errorCount = Object.keys(errors).length

  return (
    <form onSubmit={submit} noValidate className="grid gap-6" aria-label={form.title} data-testid="document-form">
      {header}
      <p className="text-base text-muted-foreground">{form.intro}</p>

      {restored && (
        <Alert>
          <RotateCcw className="size-4" aria-hidden="true" />
          <AlertTitle>Je concept van eerder is teruggezet</AlertTitle>
          <AlertDescription className="grid gap-2">
            <span>Wat je al had ingevuld, met foto&apos;s en handtekening, staat er weer.</span>
            <Button type="button" variant="outline" className={`h-11 w-fit text-base ${RING}`} onClick={() => setConfirmRestart(true)}>Opnieuw beginnen</Button>
          </AlertDescription>
        </Alert>
      )}

      {form.sections.map((section) => (
        <Card key={section.id}>
          <CardHeader>
            <CardTitle className="text-xl">{section.title}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-6">
            {section.fields.map((field) => (
              <Field key={field.id} field={field} error={errorOf(field.id)}>
                {(a11y) => {
                  const common = { id: a11y.id, 'aria-invalid': a11y.invalid, 'aria-describedby': a11y.describedBy }
                  const value = typeof draft.answers[field.id] === 'string' ? (draft.answers[field.id] as string) : ''
                  switch (field.kind) {
                    case 'text':
                      return <Input {...common} className={CONTROL} value={value} onChange={(event) => change(field.id, (d) => setText(d, field.id, event.target.value))} />
                    case 'textarea':
                      return <Textarea {...common} className={`min-h-28 text-base ${RING}`} value={value} onChange={(event) => change(field.id, (d) => setText(d, field.id, event.target.value))} />
                    case 'number':
                      return (
                        <div className="flex items-center gap-2">
                          <Input {...common} className={CONTROL} inputMode="decimal" value={value} onChange={(event) => change(field.id, (d) => setText(d, field.id, event.target.value))} />
                          {field.unit && <span className="text-base text-muted-foreground">{field.unit}</span>}
                        </div>
                      )
                    case 'date':
                      return <Input {...common} className={CONTROL} type="date" value={value} onChange={(event) => change(field.id, (d) => setText(d, field.id, event.target.value))} />
                    case 'choice':
                      return (
                        <select {...common} value={value} onChange={(event) => change(field.id, (d) => setText(d, field.id, event.target.value))} className={`flex h-12 w-full rounded-md border border-input bg-background px-3 text-base shadow-sm outline-none ${RING}`}>
                          <option value="">Kies…</option>
                          {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      )
                    case 'yesno':
                      return (
                        <YesNoControl field={field} draft={draft} a11y={a11y} onChoose={(choice) => change(field.id, (d) => setYesNo(d, field, choice))} onNote={(note) => change(field.id, (d) => setNote(d, field.id, note))} />
                      )
                    case 'photos':
                      return (
                        <PhotosControl form={form} field={field} draft={draft} a11y={a11y} onAdd={(photo) => change(field.id, (d) => addPhoto(form, d, field, photo))} onRemove={(index) => change(field.id, (d) => removePhoto(d, field.id, index))} />
                      )
                  }
                }}
              </Field>
            ))}
          </CardContent>
        </Card>
      ))}

      {errors._form && <p className="text-sm font-medium text-destructive" role="alert">{errors._form}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">Handtekening van de klant</CardTitle>
          <CardDescription>{form.signatureStatement}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor={domId('signature.name')} className="text-base">Naam van de klant</Label>
            <Input
              id={domId('signature.name')}
              className={CONTROL}
              autoComplete="off"
              value={draft.signature.name}
              aria-invalid={Boolean(errorOf('signature.name'))}
              aria-describedby={errorOf('signature.name') ? `${domId('signature.name')}-error` : undefined}
              onChange={(event) => change('signature.name', (d) => setSignatureName(d, event.target.value))}
            />
            {errorOf('signature.name') && <p id={`${domId('signature.name')}-error`} className="flex items-start gap-1.5 text-sm font-medium text-destructive" role="alert"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {errorOf('signature.name')}</p>}
          </div>
          <div className="grid gap-2">
            <p className="text-base font-medium">Handtekening</p>
            <SignaturePad
              id={domId('signature.image')}
              value={draft.signature.image}
              invalid={Boolean(errorOf('signature.image'))}
              describedBy={errorOf('signature.image') ? `${domId('signature.image')}-error` : undefined}
              onChange={(image) => change('signature.image', (d) => setSignatureImage(d, image))}
            />
            {errorOf('signature.image') && <p id={`${domId('signature.image')}-error`} className="flex items-start gap-1.5 text-sm font-medium text-destructive" role="alert"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {errorOf('signature.image')}</p>}
          </div>
        </CardContent>
      </Card>

      {errorCount > 0 && !problem && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden="true" />
          <AlertTitle>{errorCount === 1 ? 'Er is nog 1 veld dat niet klopt' : `Er zijn nog ${errorCount} velden die niet kloppen`}</AlertTitle>
          <AlertDescription>De velden zijn gemarkeerd. Je concept blijft bewaard.</AlertDescription>
        </Alert>
      )}

      {problem && (
        <Alert variant="destructive" data-testid="document-problem">
          <AlertTriangle className="size-4" aria-hidden="true" />
          <AlertTitle>{problem.kind === 'unknown' ? 'Niet zeker of het is aangekomen' : problem.kind === 'offline' ? 'Geen verbinding' : 'Niet verstuurd'}</AlertTitle>
          <AlertDescription className="grid gap-3">
            <span>{problem.message}</span>
            {problem.kind === 'unknown' && (
              <>
                <span>Vraag de planner bij de klant in Odoo te kijken of het document er staat. Staat het er niet, dan kun je het opnieuw versturen.</span>
                <Button type="button" variant="outline" className={`h-11 w-fit text-base ${RING}`} onClick={() => setConfirmResend(true)} disabled={send.isPending}>Het staat er niet: opnieuw versturen</Button>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-2">
        <Button type="submit" className={`h-14 text-lg ${RING}`} disabled={send.isPending || problem?.kind === 'unknown'}>
          {send.isPending ? 'Bezig met versturen…' : problem?.kind === 'failed' || problem?.kind === 'offline' ? 'Opnieuw proberen' : 'Versturen naar Odoo'}
        </Button>
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          {send.isPending ? "Even geduld, met veel foto's duurt dit langer. Sluit deze pagina niet." : kept === false ? 'Let op: dit concept kon niet op de telefoon worden bewaard (opslag vol of uitgezet).' : 'Je concept wordt bewaard op deze telefoon tot het is verstuurd.'}
        </p>
      </div>

      <AlertDialog open={confirmRestart} onOpenChange={setConfirmRestart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Opnieuw beginnen?</AlertDialogTitle>
            <AlertDialogDescription>Alles wat je hebt ingevuld, de foto&apos;s en de handtekening worden gewist.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Terug</AlertDialogCancel>
            <AlertDialogAction onClick={() => void startOver()}>Alles wissen</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmResend} onOpenChange={setConfirmResend}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Opnieuw versturen?</AlertDialogTitle>
            <AlertDialogDescription>Doe dit alleen als je hebt gezien dat het document niet bij de klant in Odoo staat. Anders komt het er twee keer te staan.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Terug</AlertDialogCancel>
            <AlertDialogAction onClick={sendAsNew}>Ja, opnieuw versturen</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  )
}
