import { Outlet } from 'react-router'
import Sidebar from '../components/sidebar'

export default function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-page">
      <Sidebar />
      <Outlet />
    </div>
  )
}
