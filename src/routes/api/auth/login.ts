import { createFileRoute } from '@tanstack/react-router'
import { loginBuilderUser } from '#/lib/builder-auth.server'

export const Route = createFileRoute('/api/auth/login')({
  server: { handlers: { POST: ({ request }) => loginBuilderUser(request) } },
})
