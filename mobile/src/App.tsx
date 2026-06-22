import { useState, useMemo, useEffect } from 'react';
import {
  IconChartLine,
  IconArrowsSort,
  IconBriefcase,
  IconWallet,
  IconCheck,
  IconUser,
  IconX,
  IconTrendingUp,
  IconInfoCircle,
} from '@tabler/icons-react';
import { useOptionsState } from './hooks/use-options-state';

const ASSET_CENTERS: Record<string, number> = {
  BTC: 98200,
  ETH: 3450,
  SUI: 3.65,
};

// Sparkline SVG helper
function Sparkline({ data, color }: { data: { price: number }[]; color: string }) {
  if (data.length < 5) return null;
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const w = 80;
  const h = 24;
  const points = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = h - ((d.price - min) / range) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  );
}

export default function App() {
  const s = useOptionsState();
  const [activeTab, setActiveTab] = useState<'markets' | 'trade' | 'portfolio'>('trade');
  
  // Track previous prices to flash color changes
  const [_prevPrices, setPrevPrices] = useState<Record<string, number>>({});
  const [priceDirections, setPriceDirections] = useState<Record<string, 'up' | 'down' | 'same'>>({});
  
  // Expanded strike row in the DOM Price Ladder
  const [expandedRowIdx, setExpandedRowIdx] = useState<number | null>(null);

  // Bottom Detail Drawer for trade confirmation
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [slippage, setSlippage] = useState('1.0');
  
  // Toggle default stake selector
  const [showStakeSelector, setShowStakeSelector] = useState(false);

  // Track price changes for markets page flashes
  useEffect(() => {
    setPrevPrices((prev) => {
      const next = { ...prev };
      const currentPrice = s.price;
      
      const prevPrice = prev[s.asset];
      if (prevPrice !== undefined && prevPrice !== currentPrice) {
        setPriceDirections((dirs) => ({
          ...dirs,
          [s.asset]: currentPrice > prevPrice ? 'up' : 'down',
        }));
      }
      next[s.asset] = currentPrice;
      return next;
    });
  }, [s.price, s.asset]);

  // Selected epoch details
  const selectedEpoch = useMemo(() => {
    return s.epochs.find((e) => e.id === s.selectedEpochId) || s.epochs[0];
  }, [s.epochs, s.selectedEpochId]);

  // Time remaining on selected epoch
  const [remainingSecs, setRemainingSecs] = useState(0);
  useEffect(() => {
    if (!selectedEpoch) return;
    const interval = setInterval(() => {
      const diff = Math.max(0, Math.floor((selectedEpoch.end - Date.now()) / 1000));
      setRemainingSecs(diff);
    }, 500);
    return () => clearInterval(interval);
  }, [selectedEpoch]);

  const activeLegs = useMemo(() => s.legs.filter((l) => l.status === 'active'), [s.legs]);
  const selectedLegs = useMemo(() => s.legs.filter((l) => l.status === 'selected'), [s.legs]);
  const wonLegs = useMemo(() => s.legs.filter((l) => l.status === 'won'), [s.legs]);
  const settledLegs = useMemo(() => s.legs.filter((l) => l.status === 'won' || l.status === 'lost' || l.status === 'claimed'), [s.legs]);

  const totalCost = selectedLegs.reduce((sum, l) => sum + l.cost, 0);

  // Expected value of selected legs
  const selectedEV = useMemo(() => {
    let ev = 0;
    for (const leg of selectedLegs) {
      ev += leg.cost * leg.multiplier * leg.prob - leg.cost;
    }
    return ev;
  }, [selectedLegs]);

  // Average probability
  const avgProb = useMemo(() => {
    if (selectedLegs.length === 0) return 0;
    return selectedLegs.reduce((sum, l) => sum + l.prob, 0) / selectedLegs.length;
  }, [selectedLegs]);

  const handleQuickStakeSelect = (val: number) => {
    s.setStake(val);
  };

  const handlePlaceOrder = () => {
    s.confirmOrders();
    setDetailDrawerOpen(false);
  };

  const fmtTime = (t: number) => {
    const d = new Date(t);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="app-container">
      {/* ── Top Header ── */}
      {activeTab !== 'trade' && (
        <header className="top-nav">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded bg-brand-violet flex items-center justify-center font-bold text-white text-[14px]">C</div>
            <span className="font-extrabold text-[16px] tracking-wider text-text-primary">CERIDA</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded-sm bg-brand-violet/20 text-accent-light font-bold">MOBILE</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 bg-white/[0.04] px-2.5 py-1.5 rounded-sm border border-border-subtle">
              <IconWallet size={14} className="text-text-tertiary" />
              <span className="text-[12px] font-bold" style={{ fontFamily: 'var(--font-mono)' }}>
                ${s.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span className="text-[9px] text-bullish font-semibold">USDC</span>
            </div>
            <div className="w-8 h-8 rounded-full bg-white/[0.06] flex items-center justify-center border border-border-subtle">
              <IconUser size={16} className="text-text-secondary" />
            </div>
          </div>
        </header>
      )}

      {/* ── App Views ── */}
      <main className="app-content">
        
        {/* ── Tab: Markets ── */}
        {activeTab === 'markets' && (
          <div className="p-4 flex flex-col gap-4">
            <div className="bg-card border border-border-subtle p-4 rounded-md flex flex-col gap-2 relative overflow-hidden">
              <div className="absolute right-[-10px] bottom-[-10px] opacity-10 text-white">
                <IconChartLine size={120} />
              </div>
              <span className="text-[10px] text-text-quaternary uppercase tracking-wider font-semibold">Market Volatility Index</span>
              <div className="flex items-baseline gap-2">
                <span className="text-[28px] font-extrabold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                  74.8%
                </span>
                <span className="text-[11px] text-bullish font-bold flex items-center">
                  <IconTrendingUp size={12} /> +2.4% (24h)
                </span>
              </div>
              <p className="text-[11px] text-text-tertiary max-w-[240px]">
                IV stands rich relative to historical distribution. Options yield premium sells.
              </p>
            </div>

            <span className="text-[11px] font-bold uppercase tracking-wider text-text-quaternary px-1">Ticking Spot Markets</span>
            <div className="flex flex-col gap-2">
              {['BTC', 'ETH', 'SUI'].map((t) => {
                const isSelected = s.asset === t;
                const spotPrice = isSelected ? s.price : ASSET_CENTERS[t]!;
                const dir = isSelected ? priceDirections[t] || 'same' : 'same';
                const formattedPrice = t === 'SUI' 
                  ? spotPrice.toFixed(3)
                  : spotPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                
                return (
                  <div
                    key={t}
                    onClick={() => {
                      s.setAsset(t);
                      setActiveTab('trade');
                    }}
                    className={`flex items-center justify-between p-3.5 rounded-md border transition-all cursor-pointer ${
                      isSelected ? 'border-brand-violet bg-brand-violet/5' : 'border-border-subtle bg-surface'
                    }`}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[14px] font-extrabold text-text-primary">{t}/USD</span>
                      <span className="text-[10px] text-text-quaternary">
                        {t === 'BTC' ? 'Bitcoin' : t === 'ETH' ? 'Ethereum' : 'Sui Asset'}
                      </span>
                    </div>

                    <div className="flex items-center gap-4">
                      {/* Mini Sparkline */}
                      {isSelected && s.history.length > 5 && (
                        <div className="opacity-80">
                          <Sparkline data={s.history} color={dir === 'up' ? '#35df8d' : dir === 'down' ? '#d11d45' : '#7132f5'} />
                        </div>
                      )}
                      
                      <div className="flex flex-col items-end gap-0.5">
                        <span
                          className={`text-[14px] font-bold transition-all px-1.5 py-0.5 rounded-sm ${
                            dir === 'up'
                              ? 'bg-bullish/25 text-bullish'
                              : dir === 'down'
                              ? 'bg-bearish/25 text-bearish'
                              : 'text-text-primary'
                          }`}
                          style={{ fontFamily: 'var(--font-mono)' }}
                        >
                          ${formattedPrice}
                        </span>
                        <span className="text-[10px] text-text-quaternary font-medium">
                          IV: {t === 'BTC' ? '68%' : t === 'ETH' ? '72%' : '84%'}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Tab: Trade (Vertical Price DOM Ladder) ── */}
        {activeTab === 'trade' && (
          <div className="dom-ladder-container">
            {/* Asset Header Toolbar (Mockup Style) */}
            <div className="flex items-center justify-between px-5 pt-3.5 pb-2 shrink-0 bg-[#0b041a] border-b border-[#686b82]/10">
              <button
                onClick={() => setActiveTab('markets')}
                className="text-text-secondary hover:text-white p-1 cursor-pointer transition-colors"
              >
                <IconX size={20} />
              </button>
              <div className="flex items-center gap-1 bg-[#191322] px-3.5 py-1.5 rounded-full border border-[#686b82]/20 cursor-pointer">
                <span className="text-[13px] font-bold text-white tracking-wide">/{s.asset}</span>
                <svg className="w-3.5 h-3.5 text-text-quaternary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                </svg>
              </div>
              <div className="flex items-center gap-4 text-text-secondary">
                <button
                  onClick={() => s.clearSelected()}
                  className="hover:text-white cursor-pointer transition-colors p-1"
                  title="Clear Selected"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <circle cx="12" cy="12" r="9" strokeWidth="2" stroke="currentColor" />
                    <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" strokeWidth="2" stroke="currentColor" />
                  </svg>
                </button>
                <button
                  className={`cursor-pointer transition-colors p-1 ${showStakeSelector ? 'text-accent-light' : 'hover:text-white'}`}
                  onClick={() => setShowStakeSelector(!showStakeSelector)}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Performance/State Row (Mockup Style) */}
            <div className="grid grid-cols-3 py-2.5 bg-[#0b041a] text-center border-b border-[#686b82]/10 shrink-0">
              <div className="flex flex-col items-center">
                <span className="text-[12px] font-bold text-bullish">
                  +${wonLegs.length > 0 ? (wonLegs.reduce((sum, l) => sum + l.cost * (l.multiplier - 1), 0)).toFixed(0) : '0'}
                </span>
                <span className="text-[9px] text-text-tertiary font-semibold mt-0.5">Day P&L</span>
              </div>
              <div className="flex flex-col items-center">
                <span className={`text-[12px] font-bold ${activeLegs.length > 0 ? 'text-bullish' : 'text-text-secondary'}`}>
                  {activeLegs.length > 0 ? `+${activeLegs.reduce((sum, l) => sum + l.cost, 0)} @ ${s.price.toFixed(0)}` : '0.00'}
                </span>
                <span className="text-[9px] text-text-tertiary font-semibold mt-0.5">Position</span>
              </div>
              <div className="flex flex-col items-center">
                <span className="text-[12px] font-bold text-white">
                  {selectedLegs.length}
                </span>
                <span className="text-[9px] text-text-tertiary font-semibold mt-0.5">Pending orders</span>
              </div>
            </div>

            {/* Epoch Horizontal Selector */}
            <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[#686b82]/10 overflow-x-auto no-scrollbar shrink-0 bg-[#0b041a]">
              {s.epochs.slice(1).map((e) => {
                const isSelected = s.selectedEpochId === e.id;
                const isLive = e.idx === 1;
                return (
                  <button
                    key={e.id}
                    onClick={() => s.setSelectedEpochId(e.id)}
                    className={`flex-shrink-0 px-3 py-2 rounded-sm border flex flex-col items-center gap-0.5 cursor-pointer ${
                      isSelected
                        ? 'border-brand-violet bg-brand-violet/10 text-white'
                        : 'border-border-subtle bg-card text-text-quaternary'
                    }`}
                  >
                    <span className="text-[10px] font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
                      {fmtTime(e.start)}
                    </span>
                    <span className="text-[9px] font-medium opacity-80">
                      {isLive ? 'LIVE' : `+${e.idx - 1}m`}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Header info */}
            {selectedEpoch && (
              <div className="px-4 py-1.5 bg-card border-b border-[#686b82]/10 flex items-center justify-between text-[11px] text-text-quaternary shrink-0">
                <span className="flex items-center gap-1">
                  <IconInfoCircle size={12} />
                  Spot: <span className="text-text-secondary font-bold" style={{ fontFamily: 'var(--font-mono)' }}>
                    ${s.price.toFixed(s.asset === 'SUI' ? 3 : 2)}
                  </span>
                </span>
                <span className="flex items-center gap-1 font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
                  Expires in: <span className="text-accent-light">{remainingSecs}s</span>
                </span>
              </div>
            )}

            {/* DOM Vertical Ladder viewport */}
            <div className="flex-1 overflow-y-auto no-scrollbar relative bg-[#0b041a]">
              <div className="flex flex-col py-1">
                {s.bands.map((band, idx) => {
                  const isExpanded = expandedRowIdx === idx;
                  
                  const legYES = s.legs.find((l) => l.epochId === selectedEpoch.id && l.bandIdx === band.idx && l.type === 'YES');
                  const legNO = s.legs.find((l) => l.epochId === selectedEpoch.id && l.bandIdx === band.idx && l.type === 'NO');

                  const priceVal = s.price;
                  const isAtTheMoney = priceVal >= band.lower && priceVal < band.upper;

                  // Volume histograms (mockup density mapping)
                  const centerIdx = 5;
                  const dist = Math.abs(idx - centerIdx);
                  const density = Math.max(8, Math.min(90, 85 * Math.exp(-0.5 * (dist / 2.5) ** 2)));

                  return (
                    <div
                      key={band.idx}
                      className={`flex flex-col transition-all relative ${
                        isExpanded ? 'bg-[#191322]/40 border-y border-[#7132f5]/20' : 'border-b border-[#686b82]/5'
                      }`}
                    >
                      {/* Interactive row container */}
                      <div
                        onClick={() => setExpandedRowIdx(isExpanded ? null : idx)}
                        className="flex items-center min-h-[44px] px-2 relative transition-colors hover:bg-white/[0.01]"
                      >
                        {/* 1. Left Side: Bids (YES) Area (41% width) */}
                        <div className="w-[41%] flex items-center justify-end relative h-full min-h-[44px]">
                          {/* Green volume bar extending leftwards from center */}
                          <div
                            className="absolute right-0 h-7 bg-bullish/15 border-r-2 border-bullish transition-all duration-300"
                            style={{ width: `${density}%`, opacity: 0.85 }}
                          />
                          {/* Size label placed to the left of the bar */}
                          <span
                            className="absolute text-bullish font-bold text-[9px]"
                            style={{ right: `calc(${density}% + 8px)`, fontFamily: 'var(--font-mono)' }}
                          >
                            {Math.round(density * 0.4 + 2)}
                          </span>

                          {/* Floating active position pill (left aligned in bids area) */}
                          {legYES && (
                            <div className="absolute left-2 z-20 flex items-center gap-1 bg-[#d2f53c] text-black font-extrabold text-[9px] px-2 py-0.5 rounded-full shadow shadow-[#d2f53c]/35 animate-pulse">
                              +{legYES.cost} YES
                            </div>
                          )}
                        </div>

                        {/* 2. Middle: Price Column (18% width) */}
                        <div className="w-[18%] flex items-center justify-center z-20">
                          {isAtTheMoney ? (
                            <div className="bg-[#191322] border border-[#855bfb] px-2.5 py-0.5 rounded-full shadow-lg">
                              <span className="text-[11px] font-bold text-white" style={{ fontFamily: 'var(--font-mono)' }}>
                                {band.lower.toLocaleString(undefined, { minimumFractionDigits: s.asset === 'SUI' ? 3 : 0 })}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[11px] font-medium text-text-tertiary" style={{ fontFamily: 'var(--font-mono)' }}>
                              {band.lower.toLocaleString(undefined, { minimumFractionDigits: s.asset === 'SUI' ? 3 : 0 })}
                            </span>
                          )}
                        </div>

                        {/* 3. Right Side: Asks (NO) Area (41% width) */}
                        <div className="w-[41%] flex items-center justify-start relative h-full min-h-[44px]">
                          {/* Red volume bar extending rightwards from center */}
                          <div
                            className="absolute left-0 h-7 bg-bearish/15 border-l-2 border-bearish transition-all duration-300"
                            style={{ width: `${density}%`, opacity: 0.85 }}
                          />
                          {/* Size label placed to the right of the bar */}
                          <span
                            className="absolute text-bearish font-bold text-[9px]"
                            style={{ left: `calc(${density}% + 8px)`, fontFamily: 'var(--font-mono)' }}
                          >
                            {Math.round(density * 0.35 + 1)}
                          </span>

                          {/* Floating active position pill (right aligned in asks area) */}
                          {legNO && (
                            <div className="absolute right-2 z-20 flex items-center gap-1 bg-[#ff5c5c] text-black font-extrabold text-[9px] px-2 py-0.5 rounded-full shadow shadow-[#ff5c5c]/35 animate-pulse">
                              +{legNO.cost} NO
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Expanding Inline Quick Order Panel (Mockup Style) */}
                      {isExpanded && (
                        <div className="px-4 py-3 bg-[#191322]/20 border-t border-[#686b82]/10 flex flex-col gap-3 z-20">
                          {/* Action button pills overlaying price row (mockup look) */}
                          <div className="flex gap-4">
                            <button
                              onClick={() => s.toggleLeg(selectedEpoch, band, 'YES')}
                              className={`flex-1 rounded-full font-extrabold text-[12px] py-2.5 px-4 flex items-center justify-center gap-1.5 transition-all shadow-lg active:scale-95 cursor-pointer ${
                                legYES
                                  ? 'bg-[#d2f53c] text-black shadow-[#d2f53c]/20'
                                  : 'bg-[#d2f53c]/20 text-[#d2f53c] border border-[#d2f53c]/30 hover:bg-[#d2f53c]/35'
                              }`}
                            >
                              {legYES ? <IconCheck size={14} stroke={3} /> : null}
                              Buy YES
                            </button>

                            <button
                              onClick={() => s.toggleLeg(selectedEpoch, band, 'NO')}
                              className={`flex-1 rounded-full font-extrabold text-[12px] py-2.5 px-4 flex items-center justify-center gap-1.5 transition-all shadow-lg active:scale-95 cursor-pointer ${
                                legNO
                                  ? 'bg-[#ff5c5c] text-black shadow-[#ff5c5c]/20'
                                  : 'bg-[#ff5c5c]/20 text-[#ff5c5c] border border-[#ff5c5c]/30 hover:bg-[#ff5c5c]/35'
                              }`}
                            >
                              {legNO ? <IconCheck size={14} stroke={3} /> : null}
                              Buy NO
                            </button>
                          </div>

                          {/* Stake input settings */}
                          {(legYES || legNO) && (
                            <div className="flex items-center justify-between p-2 rounded-sm bg-black/40 border border-border-subtle">
                              <span className="text-[10px] text-text-quaternary font-bold uppercase tracking-wider">Set Stake for this Cell:</span>
                              <div className="flex items-center gap-2">
                                {legYES && (
                                  <div className="flex items-center bg-card border border-border-subtle rounded-sm px-2.5 py-1 w-20">
                                    <span className="text-[9px] text-[#d2f53c] font-extrabold">Y: $</span>
                                    <input
                                      type="number"
                                      min={1}
                                      value={legYES.cost}
                                      onChange={(e) => s.updateLegCost(legYES.key, parseFloat(e.target.value) || 1)}
                                      className="w-full bg-transparent text-[11px] font-bold text-white text-right outline-none"
                                      style={{ fontFamily: 'var(--font-mono)' }}
                                    />
                                  </div>
                                )}
                                {legNO && (
                                  <div className="flex items-center bg-card border border-border-subtle rounded-sm px-2.5 py-1 w-20">
                                    <span className="text-[9px] text-[#ff5c5c] font-extrabold">N: $</span>
                                    <input
                                      type="number"
                                      min={1}
                                      value={legNO.cost}
                                      onChange={(e) => s.updateLegCost(legNO.key, parseFloat(e.target.value) || 1)}
                                      className="w-full bg-transparent text-[11px] font-bold text-white text-right outline-none"
                                      style={{ fontFamily: 'var(--font-mono)' }}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Floating bottom Qty selector capsule (Mockup Style) */}
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
                <button
                  onClick={() => setShowStakeSelector(!showStakeSelector)}
                  className="bg-[#191322] border border-[#686b82]/30 px-5 py-2.5 rounded-full flex items-center gap-1.5 shadow-xl hover:bg-[#221b2d] active:scale-95 transition-all cursor-pointer text-white font-bold text-[12px] tracking-wide"
                  style={{ fontFamily: 'var(--font-mono)' }}
                >
                  {s.stake} USDC
                  <span className="text-[9px] text-text-quaternary font-normal bg-white/5 px-1.5 py-0.5 rounded-full">qty</span>
                </button>
              </div>
            </div>

            {/* Quick Stake default selector ribbon (Toggleable via sliders icon or Qty pill) */}
            {showStakeSelector && (
              <div className="px-3 py-2 border-t border-border-subtle bg-surface shrink-0 flex items-center justify-between gap-2 z-20 animate-fade-in">
                <span className="text-[10px] text-text-quaternary uppercase tracking-wider font-bold">Default Stake</span>
                <div className="flex items-center gap-1.5 flex-1 justify-end">
                  {[5, 10, 25, 50, 100].map((v) => (
                    <button
                      key={v}
                      onClick={() => {
                        handleQuickStakeSelect(v);
                        setShowStakeSelector(false); // auto close on select
                      }}
                      className={`px-3 py-1.5 rounded-sm text-[11px] font-bold transition-all cursor-pointer ${
                        s.stake === v
                          ? 'bg-brand-violet/20 text-accent-light border border-brand-violet/40'
                          : 'bg-card text-text-tertiary border border-border-subtle hover:text-text-secondary'
                      }`}
                    >
                      ${v}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Bottom floating summary drawer */}
            {selectedLegs.length > 0 && (
              <div className="px-4 py-3 border-t border-brand-violet/30 bg-card flex items-center justify-between z-30 shrink-0 shadow-[0_-8px_24px_rgba(0,0,0,0.5)]">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-text-quaternary uppercase tracking-wider font-semibold">
                    Strategy Combo ({selectedLegs.length} Leg{selectedLegs.length > 1 ? 's' : ''})
                  </span>
                  <div className="flex items-baseline gap-1">
                    <span className="text-[18px] font-extrabold text-white" style={{ fontFamily: 'var(--font-mono)' }}>
                      ${totalCost.toFixed(2)}
                    </span>
                    <span className="text-[10px] text-text-quaternary">USDC</span>
                  </div>
                </div>
                <button
                  onClick={() => setDetailDrawerOpen(true)}
                  className="bg-brand-violet text-white font-bold text-[13px] px-5 py-2.5 rounded-sm transition-all hover:bg-accent-light shadow-lg shadow-brand-violet/20 cursor-pointer"
                >
                  Review Order
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Tab: Portfolio ── */}
        {activeTab === 'portfolio' && (
          <div className="p-4 flex flex-col gap-4 overflow-y-auto no-scrollbar flex-1">
            
            {/* Portfolio Summary Card */}
            <div className="bg-card border border-border-subtle p-4 rounded-md flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-border-subtle pb-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-text-quaternary uppercase tracking-wider font-semibold">Active Capital</span>
                  <span className="text-[24px] font-bold text-white" style={{ fontFamily: 'var(--font-mono)' }}>
                    ${activeLegs.reduce((sum, l) => sum + l.cost, 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5 items-end">
                  <span className="text-[10px] text-text-quaternary uppercase tracking-wider font-semibold">Net P&L</span>
                  <span className={`text-[24px] font-bold ${
                    wonLegs.length > 0 ? 'text-bullish' : 'text-text-secondary'
                  }`} style={{ fontFamily: 'var(--font-mono)' }}>
                    {wonLegs.length > 0 ? '+' : ''}${
                      (wonLegs.reduce((sum, l) => sum + l.cost * (l.multiplier - 1), 0) -
                      s.legs.filter((l) => l.status === 'lost').reduce((sum, l) => sum + l.cost, 0)).toFixed(2)
                    }
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-text-quaternary uppercase tracking-wider">Active</span>
                  <span className="text-[15px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>{activeLegs.length}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-bullish uppercase tracking-wider">Won</span>
                  <span className="text-[15px] font-bold text-bullish" style={{ fontFamily: 'var(--font-mono)' }}>{wonLegs.length}</span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] text-bearish uppercase tracking-wider">Lost</span>
                  <span className="text-[15px] font-bold text-bearish" style={{ fontFamily: 'var(--font-mono)' }}>
                    {s.legs.filter((l) => l.status === 'lost').length}
                  </span>
                </div>
              </div>
            </div>

            {/* Active options positions */}
            <div className="flex flex-col gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-text-quaternary px-1">Active Options</span>
              {activeLegs.length === 0 ? (
                <div className="text-center py-6 text-text-quaternary border border-dashed border-border-subtle rounded-md bg-card/20">
                  No active option contracts
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {activeLegs.map((leg) => {
                    const epoch = s.epochs.find((e) => e.id === leg.epochId);
                    const timeRemaining = epoch ? Math.max(0, Math.floor((epoch.end - s.now) / 1000)) : 0;
                    return (
                      <div key={leg.key} className="bg-card border border-border-subtle p-3 rounded-md flex items-center justify-between">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-sm ${
                              leg.type === 'YES' ? 'bg-bullish/25 text-bullish' : 'bg-bearish/25 text-bearish'
                            }`}>
                              {leg.type}
                            </span>
                            <span className="text-[13px] font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                              ${leg.lower}–${leg.upper}
                            </span>
                          </div>
                          <span className="text-[10px] text-text-quaternary font-semibold">
                            {leg.asset} · Stake: ${leg.cost} · {leg.multiplier.toFixed(1)}x
                          </span>
                        </div>

                        <div className="flex flex-col items-end gap-1">
                          <span className="text-[10px] text-accent-light font-bold" style={{ fontFamily: 'var(--font-mono)' }}>
                            Expires in {timeRemaining}s
                          </span>
                          <span className="text-[11px] text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                            Prob: {(leg.prob * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Won / Claimable Options */}
            {wonLegs.length > 0 && (
              <div className="flex flex-col gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-text-quaternary px-1">Settled / Claimable Options</span>
                <div className="flex flex-col gap-2">
                  {wonLegs.map((leg) => (
                    <div key={leg.key} className="bg-card border border-bullish/30 p-3 rounded-md flex items-center justify-between bg-gradient-to-r from-bullish/5 to-transparent">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] bg-bullish text-white font-bold px-1.5 py-0.5 rounded-sm">
                            {leg.type}
                          </span>
                          <span className="text-[13px] font-bold text-bullish" style={{ fontFamily: 'var(--font-mono)' }}>
                            ${leg.lower}–${leg.upper}
                          </span>
                        </div>
                        <span className="text-[10px] text-text-quaternary">
                          Stake: ${leg.cost} · Payout: <b className="text-bullish" style={{ fontFamily: 'var(--font-mono)' }}>${(leg.cost * leg.multiplier).toFixed(2)}</b>
                        </span>
                      </div>
                      <button
                        onClick={() => s.claimPayout(leg.key)}
                        className="bg-bullish hover:bg-bullish/90 text-white font-bold text-[12px] px-4 py-2 rounded-sm transition-all cursor-pointer shadow shadow-bullish/20"
                      >
                        Claim Payout
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* History tab */}
            {settledLegs.length > 0 && (
              <div className="flex flex-col gap-2 mt-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-text-quaternary">Settle History</span>
                  <span className="text-[10px] text-text-quaternary">Last 10 trades</span>
                </div>
                <div className="flex flex-col gap-2">
                  {settledLegs
                    .filter((leg) => leg.status === 'claimed' || leg.status === 'lost')
                    .slice(0, 10)
                    .map((leg) => {
                      const isWin = leg.status === 'claimed';
                      return (
                        <div key={leg.key} className="bg-page border border-border-subtle p-3 rounded-md flex items-center justify-between opacity-70">
                          <div className="flex flex-col gap-0.5">
                            <span className="text-[11px] font-bold text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                              ${leg.lower}–${leg.upper} ({leg.type})
                            </span>
                            <span className="text-[10px] text-text-quaternary">
                              Settle: ${leg.settlePrice?.toFixed(2)} · Stake: ${leg.cost}
                            </span>
                          </div>

                          <div className="flex flex-col items-end gap-0.5">
                            <span className={`text-[12px] font-bold ${
                              isWin ? 'text-bullish' : 'text-bearish'
                            }`} style={{ fontFamily: 'var(--font-mono)' }}>
                              {isWin ? `+$${(leg.cost * leg.multiplier).toFixed(2)}` : `-$${leg.cost.toFixed(2)}`}
                            </span>
                            <span className="text-[9px] uppercase tracking-wider font-semibold text-text-quaternary">
                              {leg.status}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── Floating order review modal / drawer ── */}
      {detailDrawerOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[100] flex flex-col justify-end" onClick={() => setDetailDrawerOpen(false)}>
          <div className="bg-card border-t border-border-subtle rounded-t-xl p-5 flex flex-col gap-4 max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-border-subtle pb-3">
              <span className="text-[14px] font-bold text-white">Review Option Order</span>
              <button onClick={() => setDetailDrawerOpen(false)} className="p-1 rounded-full bg-white/5 hover:bg-white/10 text-text-tertiary cursor-pointer">
                <IconX size={16} />
              </button>
            </div>

            {/* List of legs */}
            <div className="flex flex-col gap-2 max-h-48 overflow-y-auto no-scrollbar">
              {selectedLegs.map((leg) => (
                <div key={leg.key} className="flex items-center justify-between p-2.5 rounded-sm bg-white/[0.02] border border-border-subtle">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[12px] font-bold text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
                      ${leg.lower}–${leg.upper} ({leg.type})
                    </span>
                    <span className="text-[10px] text-text-quaternary">
                      Asset: {leg.asset} · Payout: {leg.multiplier.toFixed(1)}x
                    </span>
                  </div>

                  {/* Leg stake change input in drawer */}
                  <div className="flex items-center bg-black/20 border border-border-subtle rounded-sm px-2 py-1 gap-1 w-20">
                    <span className="text-text-quaternary text-[11px]">$</span>
                    <input
                      type="number"
                      min={1}
                      value={leg.cost}
                      onChange={(e) => s.updateLegCost(leg.key, parseFloat(e.target.value) || 1)}
                      className="w-full bg-transparent text-[12px] font-bold text-text-primary text-right outline-none"
                      style={{ fontFamily: 'var(--font-mono)' }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Strategy analytics */}
            <div className="bg-white/[0.01] p-3 rounded-md border border-border-subtle flex flex-col gap-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-text-quaternary">Expected Value (EV)</span>
                <span className={`font-bold ${selectedEV >= 0 ? 'text-bullish' : 'text-bearish'}`} style={{ fontFamily: 'var(--font-mono)' }}>
                  {selectedEV >= 0 ? '+$' : '−$'}{Math.abs(selectedEV).toFixed(2)}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-text-quaternary">Win Probability</span>
                <span className="font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                  {(avgProb * 100).toFixed(0)}%
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-text-quaternary">Max Risk Cap</span>
                <span className="font-bold text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                  -${totalCost.toFixed(2)}
                </span>
              </div>
            </div>

            {/* Slippage tolerance */}
            <div className="flex items-center justify-between p-2 rounded-sm bg-white/[0.02] border border-border-subtle text-[11px]">
              <span className="text-text-quaternary font-medium">Slippage Tolerance</span>
              <div className="flex items-center gap-1 bg-card border border-border-subtle rounded px-2 py-0.5 w-16">
                <input
                  type="number"
                  step={0.1}
                  value={slippage}
                  onChange={(e) => setSlippage(e.target.value)}
                  className="w-full bg-transparent text-text-primary font-bold text-right outline-none"
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
                <span className="text-text-quaternary">%</span>
              </div>
            </div>

            {/* Order total & confirmation action */}
            <div className="flex flex-col gap-2.5 pt-2 border-t border-border-subtle">
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-text-secondary font-semibold">Total Order cost:</span>
                <span className="text-[18px] font-extrabold text-white" style={{ fontFamily: 'var(--font-mono)' }}>
                  ${totalCost.toFixed(2)} USDC
                </span>
              </div>
              <button
                onClick={handlePlaceOrder}
                className="w-full py-3 rounded-sm bg-brand-violet text-white font-bold text-[14px] transition-all hover:bg-accent-light cursor-pointer"
              >
                Confirm Options Combo Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bottom Tab Navigation Bar ── */}
      <nav className="bottom-tabs">
        <button
          onClick={() => setActiveTab('markets')}
          className={`tab-button ${activeTab === 'markets' ? 'active' : ''}`}
        >
          <IconChartLine size={20} />
          <span>Markets</span>
        </button>

        <button
          onClick={() => setActiveTab('trade')}
          className={`tab-button ${activeTab === 'trade' ? 'active' : ''}`}
        >
          <IconArrowsSort size={20} />
          <span>Trade Grid</span>
        </button>

        <button
          onClick={() => setActiveTab('portfolio')}
          className={`tab-button ${activeTab === 'portfolio' ? 'active' : ''}`}
        >
          <div className="relative">
            <IconBriefcase size={20} />
            {activeLegs.length > 0 && (
              <span className="absolute top-[-4px] right-[-8px] bg-brand-violet text-white text-[9px] font-extrabold px-1 rounded-full min-w-3.5 text-center">
                {activeLegs.length}
              </span>
            )}
          </div>
          <span>Portfolio</span>
        </button>
      </nav>
    </div>
  );
}

// Simple cell stats cache to prevent CDF calculation overflow
// const _cache = new Map<string, { probYES: number; probNO: number; multYES: number; multNO: number }>();
// function getCellStatsCached(band: Band, epoch: Epoch, getCellStats: any) {
//   if (!epoch) return { probYES: 0.5, probNO: 0.5, multYES: 1.88, multNO: 1.88 };
//   const key = `${epoch.id}:${band.idx}`;
//   let stats = _cache.get(key);
//   if (!stats) {
//     stats = getCellStats(band, epoch);
//     _cache.set(key, stats!);
//   }
//   return stats!;
// }

