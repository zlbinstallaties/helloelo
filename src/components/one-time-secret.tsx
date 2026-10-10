import { useState } from 'react'
import { Button } from '@/components/ui/button'

/** A password that is shown once, with a button to copy it. It is not kept anywhere else. */
export function OneTimeSecret({ label, secret, hint }: { label: string; secret: string; hint?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
    } catch {
      setCopied(false) // the password can still be selected and copied by hand
    }
  }

  return (
    <div className="rounded-xl border border-chart-4/60 bg-chart-4/10 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="select-all rounded-md bg-background px-3 py-2 font-mono text-base">{secret}</code>
        <Button type="button" variant="outline" size="sm" onClick={copy}>
          {copied ? 'Gekopieerd' : 'Kopieer'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {hint ?? 'Dit wachtwoord is maar één keer te zien. Geef het door; het kan na het inloggen worden gewijzigd.'}
      </p>
    </div>
  )
}
