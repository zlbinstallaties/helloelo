import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { Toaster } from '@/components/ui/sonner'

// Side-effect order matters: Tailwind needs to be linked into the SSR'd
// document. Importing the stylesheet as a URL and listing it in `head.links`
// is the Start-native way (a bare `import './styles.css'` only works client-side).
import appCss from '../styles.css?url'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
      { title: 'DIG Monteursdashboard | De Installatiegroep B.V. [TEST]' },
      { name: 'description', content: 'Nederlandstalig leesgericht DIG-monteursdashboard voor De Installatiegroep B.V. [TEST], gevoed door Odoo 20 planning.slot en svs.tech.visit.' },
      { property: 'og:title', content: 'dig-monteursdashboard' },
      { property: 'og:description', content: 'Nederlandstalig leesgericht DIG-monteursdashboard voor De Installatiegroep B.V. [TEST], gevoed door Odoo 20 planning.slot en svs.tech.visit.' },
      { property: 'og:type', content: 'website' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      {
        rel: 'preconnect',
        href: 'https://fonts.gstatic.com',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap',
      },
    ],
  }),
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="nl">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Toaster richColors position="top-right" />
        <Scripts />
      </body>
    </html>
  )
}
