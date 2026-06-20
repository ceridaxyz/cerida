import { useState, useRef, useEffect } from 'react'
import {
  IconSearch,
  IconStar,
  IconWorld,
  IconChevronDown,
  IconPlus,
  IconKeyboard,
  IconBell,
} from '@tabler/icons-react'

interface AddOption { type: string; label: string }
interface TopNavProps {
  addOptions?: AddOption[]
  onAddWidget?: (type: string) => void
  onComboOpen?: () => void
};

const SearchIcon = () => <IconSearch size={15} stroke={2} />;
const StarIcon = () => <IconStar size={15} stroke={1.75} />;
const GlobeIcon = () => <IconWorld size={15} stroke={1.75} />;
const ChevronDown = () => <IconChevronDown size={12} stroke={2} />;
const PlusIcon = () => <IconPlus size={14} stroke={2.25} />;
const KeyboardIcon = () => <IconKeyboard size={14} stroke={1.75} />;
const BellIcon = () => <IconBell size={15} stroke={1.75} />;

const Stat = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-[10px] font-medium text-text-quaternary uppercase tracking-widest">
      {label}
    </span>
    <span
      className="text-[13px] font-medium"
      style={{ fontFamily: 'var(--font-mono)' }}
    >
      {children}
    </span>
  </div>
);

/* Bordered island — wraps a group of related controls */
const Island = ({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <div
    className={`flex items-center gap-1 rounded-[12px] bg-surface-primary border border-border-subtle px-1.5 py-1 ${className}`}
  >
    {children}
  </div>
);

const TopNav = ({ addOptions = [], onAddWidget, onComboOpen }: TopNavProps) => {
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!addOpen) return
    const onDown = (e: MouseEvent) => {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [addOpen])

  return (
    <div className="flex items-center gap-4 h-13 shrink-0 select-none">
      {/* Market selector island */}
      <Island>
        <button className="text-text-tertiary hover:text-text-primary transition-colors px-1.5">
          <SearchIcon />
        </button>

        <button className="flex items-center gap-2.5 hover:bg-surface-card rounded-[8px] px-2 py-1 transition-colors">
          <div className="w-7 h-7 rounded-full bg-[#f7931a] flex items-center justify-center text-white text-[14px] font-bold shrink-0">
            ₿
          </div>
          <div className="flex flex-col items-start h-2.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[13px] font-semibold text-text-primary">
                BTC/USD
              </span>
              <span className="text-[10px] font-medium text-text-tertiary bg-surface-card border border-border-subtle rounded-badge px-1 py-px">
                10x
              </span>
            </div>
            {/* <span className="text-[11px] text-text-quaternary">Bitcoin</span> */}
          </div>
          <span
            className="ml-1 text-[10px] text-text-quaternary bg-surface-card border border-border-subtle rounded-badge px-1.5 py-0.5"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            ⌘K
          </span>
        </button>

        <button className="text-text-tertiary hover:text-warning transition-colors px-1.5">
          <StarIcon />
        </button>
      </Island>

      {/* Stats — plain, no border */}
      <div className="flex items-center gap-6 min-w-0 overflow-hidden px-1">
        <Stat label="Last price">
          <span className="text-bearish-red">63,347.1</span>
          <span className="text-text-tertiary text-[11px] ml-1">USD</span>
        </Stat>
        <Stat label="24h change">
          <span className="text-bullish-green">0.95%</span>
        </Stat>
        <Stat label="24h volume">
          <span className="text-text-primary">1.47K</span>
          <span className="text-text-tertiary text-[11px] ml-1">BTC</span>
          <span className="text-text-primary ml-2">93.2M</span>
          <span className="text-text-tertiary text-[11px] ml-1">USD</span>
        </Stat>
      </div>

      {/* Right side */}
      <div className="flex items-center gap-2 ml-auto shrink-0">
        {/* Hotkeys + Add Widgets */}
        <button className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary rounded-[10px] bg-surface-primary border border-border-subtle px-2.5 py-1.5 transition-colors">
          <KeyboardIcon />
          Hotkeys
        </button>
        <div className="relative" ref={addRef}>
          <button
            onClick={() => setAddOpen((o) => !o)}
            className={`flex items-center gap-1.5 text-[12px] font-medium rounded-[10px] bg-surface-primary border px-2.5 py-1.5 transition-colors ${
              addOpen
                ? 'text-text-primary border-border-default'
                : 'text-text-secondary hover:text-text-primary border-border-subtle'
            }`}
          >
            <PlusIcon />
            Add Widgets
          </button>

          {addOpen && (
            <div className="absolute right-0 top-full mt-1.5 w-44 z-50 rounded-[12px] bg-surface-primary border border-border-default shadow-xl py-1.5">
              <p className="px-3 py-1 text-[10px] font-medium text-text-quaternary uppercase tracking-widest">
                Add widget
              </p>
              {addOptions.map((opt) => (
                <button
                  key={opt.type}
                  onClick={() => {
                    onAddWidget?.(opt.type)
                    setAddOpen(false)
                  }}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-card transition-colors"
                >
                  <IconPlus size={13} stroke={2} className="text-text-quaternary" />
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Combo */}
        <button
          onClick={onComboOpen}
          className="flex items-center gap-1.5 text-[12px] font-semibold rounded-[10px] px-2.5 py-1.5 transition-all"
          style={{
            background: 'rgba(128,125,254,0.1)',
            color: '#807dfe',
            border: '1px solid rgba(128,125,254,0.25)',
          }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(128,125,254,0.18)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(128,125,254,0.1)' }}
        >
          Combo
        </button>

        {/* Divider */}
        <div className="w-px h-5 bg-border-subtle mx-0.5" />

        {/* Notifications */}
        <button className="relative text-text-tertiary hover:text-text-primary transition-colors p-1.5">
          <BellIcon />
          <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-bearish-red" />
        </button>

        <Island>
          <button className="flex items-center gap-1.5 text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-card rounded-[8px] px-2.5 py-1.5 transition-colors">
            Advanced
            <ChevronDown />
          </button>
          <button className="text-text-tertiary hover:text-text-primary transition-colors p-1.5">
            <GlobeIcon />
          </button>
        </Island>

        <button className="text-[12px] font-medium text-text-secondary hover:text-text-primary rounded-[8px] px-2.5 py-1.5 hover:bg-surface-card transition-colors">
          Sign in
        </button>
        <button className="text-[12px] font-semibold text-black bg-white rounded-[10px] px-3 py-1.5 hover:opacity-90 transition-opacity">
          Sign up
        </button>
      </div>
    </div>
  );
};

export default TopNav;
