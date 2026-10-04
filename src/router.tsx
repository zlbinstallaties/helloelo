import { QueryClient } from '@tanstack/react-query'
import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'
import { DefaultErrorComponent } from '@/components/error-component'

// TanStack Start calls getRouter() on both server and client.
// setupRouterSsrQueryIntegration wires the QueryClient into the router context
// and handles SSR dehydration / rehydration, so loaders can call
// context.queryClient.ensureQueryData() and the client picks the cache up
// without refetching.
export function getRouter() {
  const queryClient = new QueryClient()

  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Catches uncaught render/loader errors on any route. Routes can still
    // set their own `errorComponent` to override this.
    defaultErrorComponent: DefaultErrorComponent,
    defaultPreload: 'intent',
    // With React Query we never want loader data to be stale -- the loader runs
    // on every preload/visit and React Query owns caching from there.
    defaultPreloadStaleTime: 0,
  })

  setupRouterSsrQueryIntegration({ router, queryClient })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
