import { createFileRoute } from '@tanstack/react-router'
import { logoutBuilderUser } from '#/lib/builder-auth.server'

export const Route = createFileRoute('/api/auth/logout')({
  server: { handlers: { POST: ({ request }) => logoutBuilderUser(request) } },
})
