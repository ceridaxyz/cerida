import { NavLink } from 'react-router'

const BellIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
)

const UserIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
)

const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="6 9 12 15 18 9" />
  </svg>
)

const Navbar = () => (
  <nav className="flex items-center h-[46px] px-4 border-b border-border-subtle shrink-0" style={{ backgroundColor: '#161616' }}>
    {/* Logo */}
    <NavLink to="/" className="flex items-center justify-center w-7 h-7 rounded-[6px] bg-brand-violet mr-5 shrink-0">
      <span className="text-white font-bold text-[13px] leading-none" style={{ fontFamily: 'Barlow, sans-serif' }}>U</span>
    </NavLink>

    {/* Nav links */}
    <div className="flex items-center gap-0.5 flex-1">
      <NavLink
        to="/markets"
        className={({ isActive }) =>
          `px-3 py-1.5 text-[15px] font-medium rounded-[6px] transition-colors ${isActive ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'}`
        }
      >
        Markets
      </NavLink>
      <NavLink
        to="/portfolio"
        className={({ isActive }) =>
          `px-3 py-1.5 text-[15px] font-medium rounded-[6px] transition-colors ${isActive ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'}`
        }
      >
        Portfolio
      </NavLink>
      <NavLink
        to="/points"
        className={({ isActive }) =>
          `px-3 py-1.5 text-[15px] font-medium rounded-[6px] transition-colors ${isActive ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'}`
        }
      >
        Points
      </NavLink>
      <NavLink
        to="/docs"
        className={({ isActive }) =>
          `px-3 py-1.5 text-[15px] font-medium rounded-[6px] transition-colors ${isActive ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'}`
        }
      >
        Docs
      </NavLink>
      <button className="flex items-center gap-1.5 px-3 py-1.5 text-[15px] font-medium text-text-secondary border border-border-subtle rounded-[6px] hover:text-text-primary hover:border-surface-hover transition-colors">
        How it works?
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-surface-hover text-text-tertiary text-[10px] leading-none">?</span>
      </button>
    </div>

    {/* Right side */}
    <div className="flex items-center gap-2">
      {/* Bell */}
      <button className="w-8 h-8 flex items-center justify-center text-text-secondary hover:text-text-primary rounded-[6px] hover:bg-surface-hover transition-colors">
        <BellIcon />
      </button>

      {/* Balance */}
      <div className="flex items-center gap-1.5 bg-surface-card border border-border-subtle rounded-[6px] px-3 py-1.5 cursor-pointer hover:bg-surface-hover transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-brand-violet shrink-0">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
          <path d="M12 6v12M8 10l4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="text-text-primary text-[15px] font-medium" style={{ fontFamily: 'JetBrains Mono, monospace' }}>$0</span>
        <ChevronDownIcon />
      </div>

      {/* Sign in */}
      <button className="px-4 py-1.5 bg-sign-in-cta text-white text-[15px] font-medium rounded-[6px] hover:opacity-90 transition-opacity">
        Sign in
      </button>

      {/* Profile */}
      <button className="w-8 h-8 flex items-center justify-center text-text-secondary hover:text-text-primary rounded-[6px] hover:bg-surface-hover transition-colors border border-border-subtle">
        <UserIcon />
      </button>
    </div>
  </nav>
)

export default Navbar
