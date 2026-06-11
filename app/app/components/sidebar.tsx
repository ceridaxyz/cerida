import { useEffect, useState } from 'react'
import { NavLink } from 'react-router'

const HomeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
)

const MarketsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
)

const PortfolioIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2" />
    <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
  </svg>
)

const PointsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
)

const DocsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
  </svg>
)

const UserIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
)

const CollapseIcon = ({ collapsed }: { collapsed: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {collapsed
      ? <><polyline points="9 18 15 12 9 6" /></>
      : <><polyline points="15 18 9 12 15 6" /></>}
  </svg>
)

const Divider = () => <div className="h-px bg-border-subtle my-1.5 mx-3" />

const NavItem = ({
  to, icon, label, collapsed,
}: {
  to: string; icon: React.ReactNode; label: string; collapsed: boolean
}) => (
  <NavLink
    to={to}
    title={collapsed ? label : undefined}
    className={({ isActive }) =>
      `flex items-center gap-3 mx-2 px-2 py-2.5 rounded-[6px] transition-colors text-[13px] font-medium ${
        isActive
          ? 'bg-surface-card text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-card/60'
      } ${collapsed ? 'justify-center' : ''}`
    }
  >
    <span className="shrink-0">{icon}</span>
    {!collapsed && <span className="truncate">{label}</span>}
  </NavLink>
)

const Sidebar = () => {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('sidebar-collapsed')
    if (stored !== null) setCollapsed(stored === 'true')
  }, [])

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

  return (
    <div
      className={`flex flex-col h-screen border-r border-border-subtle shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out ${collapsed ? 'w-14' : 'w-50'}`}
      style={{ backgroundColor: '#161616' }}
    >
      {/* Logo */}
      <div className={`flex items-center h-11.5 border-b border-border-subtle shrink-0 ${collapsed ? 'justify-center' : 'px-4'}`}>
        <NavLink to="/" className="flex items-center gap-2">
          <div className="flex items-center justify-center w-7 h-7 rounded-[6px] bg-surface-card border border-border-default shrink-0">
            <span className="text-text-primary font-bold text-[13px] leading-none">C</span>
          </div>
          {!collapsed && (
            <span className="text-[14px] font-semibold text-text-primary">cerida</span>
          )}
        </NavLink>
      </div>

      {/* Nav items */}
      <nav className="flex-1 py-3 overflow-y-auto">
        <NavItem to="/" icon={<HomeIcon />} label="Home" collapsed={collapsed} />
        <NavItem to="/trade" icon={<MarketsIcon />} label="Markets" collapsed={collapsed} />

        <Divider />

        <NavItem to="/portfolio" icon={<PortfolioIcon />} label="Portfolio" collapsed={collapsed} />
        <NavItem to="/points" icon={<PointsIcon />} label="Points" collapsed={collapsed} />

        <Divider />

        <NavItem to="/docs" icon={<DocsIcon />} label="Docs" collapsed={collapsed} />
      </nav>

      {/* Bottom: sign in + collapse */}
      <div className="border-t border-border-subtle shrink-0 p-2 flex flex-col gap-1">
        {collapsed ? (
          <button className="flex items-center justify-center w-full py-2 rounded-[6px] bg-sign-in-cta text-white hover:opacity-90 transition-opacity">
            <UserIcon />
          </button>
        ) : (
          <button className="w-full py-2 bg-sign-in-cta text-white text-[13px] font-medium rounded-[6px] hover:opacity-90 transition-opacity">
            Sign in
          </button>
        )}

        <button
          onClick={toggle}
          className={`flex items-center gap-2 w-full px-2 py-2 rounded-[6px] text-text-secondary hover:text-text-primary hover:bg-surface-card transition-colors ${collapsed ? 'justify-center' : ''}`}
        >
          <CollapseIcon collapsed={collapsed} />
          {!collapsed && <span className="text-[13px] font-medium">Collapse</span>}
        </button>
      </div>
    </div>
  )
}

export default Sidebar
