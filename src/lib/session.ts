import { useQuery } from '@tanstack/react-query'
import { api } from '#/lib/api-client'

/* Who is logged in, as the screens see it. The server decides everything; this only shows it. */

export type SessionUser = {
  id: string
  username: string
  name: string
  role: 'admin' | 'monteur'
  personId: string | null
  emergency: boolean
}

export type Me = {
  /** `off`: logins are switched off on this server (previews, development). */
  authMode: 'on' | 'off'
  user: SessionUser | null
  canRefresh: boolean
  canManageAccounts: boolean
  canCreateEmployees: boolean
}

export const ME_KEY = ['me']

export function useMe() {
  return useQuery({
    queryKey: ME_KEY,
    queryFn: () => api<Me>('/api/auth/me', { fallback: 'De sessie kon niet worden gecontroleerd.' }),
    staleTime: 30_000,
  })
}
