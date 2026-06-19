import { useState, useEffect } from 'react';

const INITIAL_BALANCE = 903.44;

export default function PredictTrading({
  currentPrice = 1356.31,
  underlying = 'ETH',
}: {
  currentPrice?: number;
  underlying?: string;
}) {
  // Price states
  const [spot, setSpot] = useState(currentPrice);
  const [roundStartPrice] = useState(1354.00);
  const [balance] = useState(INITIAL_BALANCE);
  const [roundId] = useState(325);

  const [betSide, setBetSide] = useState<'up' | 'down'>('up');
  const [amountRaw, setAmountRaw] = useState('100');

  // Simulation: Random walk for spot price
  useEffect(() => {
    const id = setInterval(() => {
      setSpot((prev) => {
        const change = (Math.random() - 0.5) * 2.2;
        const next = Math.max(100, prev + change);
        return parseFloat(next.toFixed(2));
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Dynamic multiplier calculation based on distance from startPrice
  const diff = (spot - roundStartPrice) / roundStartPrice;
  const upRatio = Math.max(0.15, Math.min(0.85, 0.5 - diff * 45)); 
  const upMultiplier = parseFloat((1.0 / upRatio).toFixed(2));
  const downMultiplier = parseFloat((1.0 / (1.0 - upRatio)).toFixed(2));

  // Option cents prices derived from multipliers (probability representation)
  const upCents = ((1.0 / upMultiplier) * 100).toFixed(1);
  const downCents = ((1.0 / downMultiplier) * 100).toFixed(1);

  const amount = parseFloat(amountRaw) || 0;
  const activeMultiplier = betSide === 'up' ? upMultiplier : downMultiplier;
  const canSubmit = amount > 0 && amount <= balance;

  const selectPct = (pct: number) => {
    setAmountRaw(((balance * pct) / 100).toFixed(2));
  };

  const handleConfirm = (side: 'up' | 'down') => {
    // Stub: do nothing yet
  };

  // Typography helpers (follow design system in trade)
  const sans = { fontFamily: "'Manrope', system-ui, -apple-system, sans-serif" };
  const mono = { fontFamily: "var(--font-mono)" };

  return (
    <div className="flex flex-col h-full bg-surface-primary text-[12px] overflow-hidden select-none" style={sans}>
      
      {/* Title Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-1.5">
          <span className="text-text-secondary font-bold text-[14px]">{underlying} Predict</span>
          <span className={`${spot >= roundStartPrice ? 'text-bullish-green' : 'text-bearish-red'} font-extrabold text-[14px]`} style={mono}>
            ${spot.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
        </div>
        <div className="flex items-center gap-1 text-text-quaternary font-bold text-[12px]" style={mono}>
          <span className="bg-surface-hover px-1.5 py-0.5 rounded text-[11px] text-text-tertiary font-bold">
            Round #{roundId}
          </span>
        </div>
      </div>

      {/* Main compact ticket layout */}
      <div className="flex flex-col flex-1 p-2.5 justify-between min-h-0 overflow-y-auto gap-2">
        
        <div className="flex flex-col gap-2">
          
          {/* UP / DOWN position stacked chevrons (custom paths matching uploaded image) */}
          <div className="flex flex-col gap-1.5 py-0.5">
            {/* UP CHEVRON BUTTON */}
            <button
              onClick={() => setBetSide('up')}
              className="relative w-full overflow-hidden focus:outline-none cursor-pointer transition-all duration-300 animate-none rounded-[12px]"
              style={{ 
                height: '66px',
                filter: betSide === 'up' ? 'drop-shadow(0 0 8px rgba(24, 166, 146, 0.2))' : 'none'
              }}
            >
              <svg viewBox="0 0 200 66" className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
                <path 
                  d="M 15,61 Q 5,61 5,51 L 5,28 Q 5,21 10,18 L 90,3 Q 100,0 110,3 L 190,18 Q 195,21 195,28 L 195,51 Q 195,61 185,61 Z" 
                  fill={betSide === 'up' ? '#18a692' : 'rgba(13, 15, 26, 0.7)'} 
                  stroke={betSide === 'up' ? '#18a692' : 'rgba(255, 255, 255, 0.08)'}
                  strokeWidth={betSide === 'up' ? 2 : 1}
                  className="transition-all duration-300"
                />
              </svg>
              {/* Overlay text exactly matching the uploaded image */}
              <div className="absolute inset-0 flex flex-col justify-center items-center pointer-events-none pt-1">
                <span className={`text-[16px] font-extrabold tracking-wide ${betSide === 'up' ? 'text-[#ffffff]' : 'text-text-primary'}`}>
                  Up
                </span>
                <span className={`text-[12px] font-bold ${betSide === 'up' ? 'text-[#ffffff]' : 'text-text-tertiary'}`} style={mono}>
                  {upCents}¢ · {upMultiplier.toFixed(2)}x
                </span>
              </div>
            </button>

            {/* DOWN CHEVRON BUTTON */}
            <button
              onClick={() => setBetSide('down')}
              className="relative w-full overflow-hidden focus:outline-none cursor-pointer transition-all duration-300 animate-none rounded-[12px]"
              style={{ 
                height: '66px',
                filter: betSide === 'down' ? 'drop-shadow(0 0 8px rgba(184, 53, 76, 0.2))' : 'none'
              }}
            >
              <svg viewBox="0 0 200 66" className="absolute inset-0 w-full h-full" preserveAspectRatio="none">
                <path 
                  d="M 15,5 Q 5,5 5,15 L 5,38 Q 5,45 10,48 L 90,63 Q 100,66 110,63 L 190,48 Q 195,45 195,38 L 195,15 Q 195,5 185,5 Z" 
                  fill={betSide === 'down' ? '#b8354c' : 'rgba(13, 15, 26, 0.7)'} 
                  stroke={betSide === 'down' ? '#b8354c' : 'rgba(255, 255, 255, 0.08)'}
                  strokeWidth={betSide === 'down' ? 2 : 1}
                  className="transition-all duration-300"
                />
              </svg>
              {/* Overlay text exactly matching the uploaded image */}
              <div className="absolute inset-0 flex flex-col justify-center items-center pointer-events-none pb-1.5">
                <span className={`text-[12px] font-bold ${betSide === 'down' ? 'text-[#ffffff]' : 'text-text-tertiary'}`} style={mono}>
                  {downMultiplier.toFixed(2)}x · {downCents}¢
                </span>
                <span className={`text-[16px] font-extrabold tracking-wide ${betSide === 'down' ? 'text-[#ffffff]' : 'text-text-primary'}`}>
                  Down
                </span>
              </div>
            </button>
          </div>

          {/* Compact Pricing Details Box */}
          <div className="grid grid-cols-3 gap-1 p-2 rounded-[8px] bg-[#0c0d16] border border-border-subtle text-center text-[11px]">
            <div className="flex flex-col">
              <span className="text-text-quaternary font-bold text-[10px]">LOCKED</span>
              <span className="text-text-secondary font-semibold text-[13px] mt-0.5" style={mono}>${roundStartPrice.toFixed(1)}</span>
            </div>
            <div className="flex flex-col border-x border-border-subtle/50">
              <span className="text-text-quaternary font-bold text-[10px]">SPOT</span>
              <span className={`font-bold text-[13px] mt-0.5 ${spot >= roundStartPrice ? 'text-bullish-green' : 'text-bearish-red'}`} style={mono}>
                ${spot.toFixed(2)}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-text-quaternary font-bold text-[10px]">PAYOUT</span>
              <span className={`font-extrabold text-[13px] mt-0.5 ${betSide === 'up' ? 'text-bullish-green' : 'text-bearish-red'}`} style={mono}>
                {activeMultiplier.toFixed(2)}x
              </span>
            </div>
          </div>

          {/* Input details */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-text-tertiary text-[12px] px-0.5">
              <span>Enter Amount</span>
              <span className="text-text-quaternary" style={mono}>
                Bal: ${balance.toFixed(2)}
              </span>
            </div>

            {/* Input field */}
            <div className="flex items-center bg-[#0c0d16] rounded-[6px] px-2 py-1.5 border border-border-subtle gap-1.5 focus-within:border-brand-violet">
              <span className="text-text-quaternary font-extrabold text-[15px]">$</span>
              <input
                type="number"
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
                placeholder="0.00"
                className="flex-1 bg-transparent text-[16px] text-text-primary outline-none font-bold placeholder:text-text-quaternary"
                style={mono}
              />
              <span className="text-[10px] px-1 py-0.5 rounded bg-surface-hover text-text-tertiary border border-border-subtle uppercase font-bold" style={mono}>
                USDT
              </span>
            </div>

            {/* Quick shortcuts */}
            <div className="grid grid-cols-5 gap-1 mt-1">
              {[10, 25, 50, 75].map((pct) => (
                <button
                  key={pct}
                  onClick={() => selectPct(pct)}
                  className="py-1 rounded bg-[#0c0d16] border border-border-subtle hover:bg-surface-hover text-[11px] text-text-tertiary hover:text-text-secondary cursor-pointer transition-colors"
                >
                  {pct}%
                </button>
              ))}
              <button
                onClick={() => selectPct(100)}
                className="py-1 rounded bg-[#0c0d16] border border-border-subtle hover:bg-surface-hover text-[11px] font-bold text-brand-violet cursor-pointer transition-colors"
              >
                MAX
              </button>
            </div>
          </div>

        </div>

        {/* Submit Block */}
        <div className="flex flex-col gap-1.5 mt-2">
          {/* Submit Button */}
          <button
            onClick={() => handleConfirm(betSide)}
            disabled={!canSubmit}
            className="w-full py-2.5 font-bold rounded-[8px] text-[13px] tracking-wide uppercase transition-all flex flex-col items-center justify-center cursor-pointer border border-transparent"
            style={{
              backgroundColor: canSubmit
                ? (betSide === 'up' ? '#18a692' : '#b8354c')
                : 'var(--color-surface-hover)',
              color: canSubmit ? '#ffffff' : 'var(--color-text-quaternary)',
            }}
          >
            <span className="font-extrabold tracking-wide">
              Buy {betSide === 'up' ? 'UP' : 'DOWN'} · {activeMultiplier.toFixed(2)}x
            </span>
            {amount > 0 && (
              <span className="text-[11px] font-medium opacity-85 mt-0.5 normal-case text-white/90" style={mono}>
                Bet ${amount.toFixed(0)} to win ${(amount * activeMultiplier).toFixed(2)}
              </span>
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
