import { createFileRoute, Outlet } from '@tanstack/react-router'
import { AdminRoute } from '@/components/layout/AdminRoute'

export const Route = createFileRoute('/admin')({
  component: AdminLayout,
})

function AdminLayout() {
  return (
    <AdminRoute>
      <Outlet />
    </AdminRoute>
  )
}
