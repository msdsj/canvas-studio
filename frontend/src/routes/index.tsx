import { createFileRoute, redirect } from '@tanstack/react-router'
import { getToken } from '@/lib/api/client'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    const token = getToken()
    throw redirect({ to: token ? '/workspace' : '/login' })
  },
})
