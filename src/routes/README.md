# Routes

TanStack Start uses file-based routing. Every `.ts` and `.tsx` file in this directory is a route. Do not create `src/pages/`, `app/layout.tsx`, or similar, those are Next.js / Remix conventions. The only root layout is `src/routes/__root.tsx`.

## Conventions

| File | URL |
| --- | --- |
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `users/index.tsx` | `/users` |
| `users/$id.tsx` | `/users/:id` (dynamic — bare `$`, no curly braces) |
| `posts.$postId.tsx` | `/posts/:postId` (dots nest without folders) |
| `admin/route.tsx` | layout for every `/admin/*` page; must render `<Outlet />` |
| `admin_.login.tsx` | `/admin/login`, but outside the admin layout (trailing `_` escapes it) |
| `_auth.tsx` | pathless layout; wraps `_auth/*` files without adding a URL segment |
| `api/health.ts` | server route for defining API endpoints |
| `__root.tsx` | app shell, wraps every page; preserve `<Outlet />` |

## Rules

- A layout route without `<Outlet />` renders its children nowhere.
- Do not `export default` route components, it breaks code splitting. Use a named function passed as `component:`.
- `routeTree.gen.ts` is auto-generated. Don't edit it by hand.

## API routes vs server functions

TanStack Start offers two ways to run server-side code:

- [Server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes) — files under `src/routes/api/` that export HTTP handlers.
- [Server functions](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions) — `createServerFn()` calls colocated with components.

Prefer API routes. Create them under `src/routes/api/` following the same convention as `src/routes/api/health.ts` (one handler per HTTP method under `server.handlers`, returning `Response.json()`). This is more scalable and gives the user visually readable endpoints (`/api/todos`, `/api/todos/:id`) they can recognize in the network monitor. Server functions are served from generated URLs that read as random gibberish, which makes requests hard to identify and debug.

## Authenticated routes

Put protected pages inside a pathless `_authed` layout and keep login/signup
at the top level, outside it. Never special-case the login pathname inside
the layout guard.

```
routes/
  __root.tsx          loads the session into router context (context.user)
  _authed.tsx         pathless guard — no URL segment of its own
  _authed/
    dashboard.tsx     /dashboard (protected)
    posts.tsx         /posts     (protected)
  index.tsx           /          (public)
  login.tsx           /login     (public)
  logout.tsx          /logout
```

`_authed.tsx` does the guarding, all children inherit it:

```tsx _authed.tsx
export const Route = createFileRoute('/_authed')({
  beforeLoad: ({ context }) => {
    if (!context.user) {
      throw redirect({ to: '/login' })
    }
  },
})
```

The session is loaded once in `__root.tsx`'s `beforeLoad` and returned into
the router context so every route can read `context.user`. `getUser()` is
whatever your auth uses (e.g. verify a JWT from localStorage) and resolves to
the user or null:

```tsx __root.tsx
// (keep the existing head() and component, add this)
export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  beforeLoad: async () => {
    const user = await getUser()
    return { user }
  },
  // ...head, component unchanged
})
```

Components read it with `Route.useRouteContext()` (e.g. to swap a Login link
for a Logout button in the shell):

```tsx
function Route() {
  const { user } = Route.useRouteContext()
  
  return (
    <nav>
      {user ? <Link to="/logout">Logout</Link> : <Link to="/login">Login</Link>}
    </nav>
  )
}
```
