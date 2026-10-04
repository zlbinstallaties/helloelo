import { useState } from 'react'
import { useRouterState } from '@tanstack/react-router'

// Rendered by the router's defaultErrorComponent for any uncaught render or
// loader error. Per-route `errorComponent` options override it. Keep this
// component free of app dependencies (toasts, auth, ui components, etc).
export function DefaultErrorComponent({ error }: { error: Error }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [copied, setCopied] = useState(false)

  async function copyForLeo() {
    // Blank lines + fenced stack so the report keeps its structure when
    // pasted into a markdown-rendering chat.
    const report = [
      'My app threw an error, please fix it:',
      `Page: ${pathname}`,
      `Error: ${error.message}`,
      ['Stack:', '```', error.stack ?? '(no stack trace)', '```'].join('\n'),
    ].join('\n\n')

    await navigator.clipboard.writeText(report)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-white p-4">
      <div className="w-full max-w-lg rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-neutral-900">
          Something went wrong
        </h2>
        <div className="mt-4 space-y-4">
          <pre className="text-sm text-red-600 whitespace-pre-wrap break-words rounded-md bg-neutral-100 p-3">
            {error.message}
          </pre>
          <button
            type="button"
            onClick={copyForLeo}
            className="inline-flex items-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-50"
          >
            {copied ? 'Copied!' : 'Copy error'}
          </button>
          <p className="text-sm text-neutral-500">
            Paste the copied error to Leo and it will help you fix it.
          </p>
        </div>
      </div>
    </div>
  )
}
