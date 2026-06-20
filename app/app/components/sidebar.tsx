import { useEffect, useState } from 'react'
import { NavLink } from 'react-router'
import {
  IconHome,
  IconActivity,
  IconLayoutGrid,
  IconBriefcase,
  IconStar,
  IconFileText,
  IconUser,
  IconSettings,
  IconChevronLeft,
  IconChevronRight,
} from '@tabler/icons-react'
import SettingsModal from './settings-modal'
import OnboardingModal, { getOnboardingSession, type OnboardingSession } from './onboarding-modal'

const HomeIcon = () => <IconHome size={18} stroke={1.75} />
const MarketsIcon = () => <IconActivity size={18} stroke={1.75} />
const GridIcon = () => <IconLayoutGrid size={18} stroke={1.75} />
const PortfolioIcon = () => <IconBriefcase size={18} stroke={1.75} />
const PointsIcon = () => <IconStar size={18} stroke={1.75} />
const DocsIcon = () => <IconFileText size={18} stroke={1.75} />
const SettingsIcon = () => <IconSettings size={18} stroke={1.75} />
const UserIcon = () => <IconUser size={16} stroke={2} />

const CollapseIcon = ({ collapsed }: { collapsed: boolean }) =>
  collapsed
    ? <IconChevronRight size={16} stroke={2} />
    : <IconChevronLeft size={16} stroke={2} />

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

const NavButton = ({
  icon, label, collapsed, onClick,
}: {
  icon: React.ReactNode; label: string; collapsed: boolean; onClick: () => void
}) => (
  <button
    onClick={onClick}
    title={collapsed ? label : undefined}
    className={`flex items-center gap-3 mx-2 px-2 py-2.5 rounded-[6px] transition-colors text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-card/60 ${collapsed ? 'justify-center' : ''}`}
  >
    <span className="shrink-0">{icon}</span>
    {!collapsed && <span className="truncate">{label}</span>}
  </button>
)

const Sidebar = () => {
  const [collapsed, setCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [onboardingOpen, setOnboardingOpen] = useState(false)
  const [session, setSession] = useState<OnboardingSession | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem('sidebar-collapsed')
    if (stored !== null) setCollapsed(stored === 'true')
  }, [])

  useEffect(() => {
    setSession(getOnboardingSession())

    const onSession = (event: Event) => {
      setSession((event as CustomEvent<OnboardingSession | null>).detail ?? getOnboardingSession())
    }

    window.addEventListener('cerida:onboarding-session', onSession)
    window.addEventListener('storage', onSession)
    return () => {
      window.removeEventListener('cerida:onboarding-session', onSession)
      window.removeEventListener('storage', onSession)
    }
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
      style={{ backgroundColor: 'var(--color-surface-primary)' }}
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

      {/* Nav items — top section */}
      <nav className="py-3 overflow-y-auto border-b border-border-subtle shrink-0">
        <NavItem to="/" icon={<HomeIcon />} label="Home" collapsed={collapsed} />
        <NavItem to="/trade" icon={<MarketsIcon />} label="Markets" collapsed={collapsed} />
        <NavItem to="/trade/grid" icon={<GridIcon />} label="Grid" collapsed={collapsed} />

        <Divider />

        <NavItem to="/portfolio" icon={<PortfolioIcon />} label="Portfolio" collapsed={collapsed} />
        <NavItem to="/points" icon={<PointsIcon />} label="Points" collapsed={collapsed} />

        <Divider />

        <NavItem to="/docs" icon={<DocsIcon />} label="Docs" collapsed={collapsed} />
        <NavButton
          icon={<SettingsIcon />}
          label="Settings"
          collapsed={collapsed}
          onClick={() => setSettingsOpen(true)}
        />
      </nav>

      {/* Lower section — empty for now */}
      <div className="flex-1" />

      {/* Bottom: sign in + collapse */}
      <div className="border-t border-border-subtle shrink-0 p-2 flex flex-col gap-1">
        {collapsed ? (
          <button
            onClick={() => setOnboardingOpen(true)}
            className="flex items-center justify-center w-full py-2 rounded-[6px] bg-sign-in-cta text-white hover:opacity-90 transition-opacity"
            title={session ? session.label : 'Sign in'}
          >
            <UserIcon />
          </button>
        ) : (
          <button
            onClick={() => setOnboardingOpen(true)}
            className="w-full rounded-[6px] bg-sign-in-cta px-2 py-2 text-white hover:opacity-90 transition-opacity"
          >
            <span className="block truncate text-[13px] font-medium">{session ? session.label : 'Sign in'}</span>
            {session && <span className="block truncate text-[10px] text-white/70">{session.address.slice(0, 6)}...{session.address.slice(-4)}</span>}
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

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <OnboardingModal open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
    </div>
  )
}

export default Sidebar
