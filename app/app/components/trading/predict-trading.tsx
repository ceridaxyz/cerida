import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  IconLock,
  IconTrophy,
  IconShare,
  IconArrowUp,
  IconArrowDown,
  IconInfoCircle,
  IconHistory,
  IconCheck,
  IconTrendingUp,
  IconTrendingDown,
} from '@tabler/icons-react';

interface Round {
  id: number;
  status: 'expired' | 'live' | 'next';
  lockedPrice: number | null;
  closePrice: number | null;
  upMultiplier: number;
  downMultiplier: number;
  upPool: number;
  downPool: number;
  verdict: 'up' | 'down' | null;
}

interface Bet {
  roundId: number;
  side: 'up' | 'down';
  amount: number;
  multiplier: number;
  status: 'pending' | 'won' | 'lost';
}

const INITIAL_BALANCE = 903.44;

export default function PredictTrading({
  currentPrice = 1341.54,
  underlying = 'ETH',
}: {
  currentPrice?: number;
  underlying?: string;
}) {
  // Timer & price states
  const [spot, setSpot] = useState(currentPrice);
  const [timeLeft, setTimeLeft] = useState(298); // 4m 58s default
  const [balance, setBalance] = useState(INITIAL_BALANCE);
  
  // Rounds state
  const [rounds, setRounds] = useState<Round[]>([
    {
      id: 323,
      status: 'expired',
      lockedPrice: 1335.20,
      closePrice: 1343.10,
      upMultiplier: 1.85,
      downMultiplier: 2.15,
      upPool: 1.5,
      downPool: 1.3,
      verdict: 'up',
    },
    {
      id: 324,
      status: 'expired', // acts as the "Locked" round ending soon
      lockedPrice: 1343.00,
      closePrice: null, // will settle at the end of countdown
      upMultiplier: 2.10,
      downMultiplier: 1.90,
      upPool: 1.2,
      downPool: 1.4,
      verdict: null,
    },
    {
      id: 325,
      status: 'live', // acts as the "Active" round users bet on
      lockedPrice: null,
      closePrice: null,
      upMultiplier: 1.84,
      downMultiplier: 2.18,
      upPool: 2.3,
      downPool: 1.9,
      verdict: null,
    },
  ]);

  const [activeTab, setActiveTab] = useState<'trade' | 'history'>('trade');
  const [selectedRoundId, setSelectedRoundId] = useState<number>(325);
  const [betSide, setBetSide] = useState<'up' | 'down'>('up');
  const [amountRaw, setAmountRaw] = useState('100');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [txSuccess, setTxSuccess] = useState(false);
  const [myBets, setMyBets] = useState<Bet[]>([]);

  // Simulation: Random walk for spot price
  useEffect(() => {
    const id = setInterval(() => {
      setSpot((prev) => {
        const change = (Math.random() - 0.5) * 2;
        const next = Math.max(100, prev + change);
        return parseFloat(next.toFixed(2));
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Timer simulation & Round Rollover
  useEffect(() => {
    const id = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          // Rollover logic
          setRounds((oldRounds) => {
            const currentSpot = spot;
            
            // Settle round 324 (which was ending)
            const settled324 = {
              ...oldRounds[1],
              status: 'expired' as const,
              closePrice: currentSpot,
              verdict: currentSpot >= (oldRounds[1].lockedPrice ?? 0) ? ('up' as const) : ('down' as const),
            };

            // Lock round 325 (which was live)
            const locked325 = {
              ...oldRounds[2],
              status: 'expired' as const, // becomes the new locked round
              lockedPrice: currentSpot,
            };

            // Create new active round 326
            const live326 = {
              id: oldRounds[2].id + 1,
              status: 'live' as const,
              lockedPrice: null,
              closePrice: null,
              upMultiplier: parseFloat((1.5 + Math.random()).toFixed(2)),
              downMultiplier: parseFloat((1.5 + Math.random()).toFixed(2)),
              upPool: parseFloat((1.0 + Math.random() * 2).toFixed(1)),
              downPool: parseFloat((1.0 + Math.random() * 2).toFixed(1)),
              verdict: null,
            };

            // Update user bets status
            setMyBets((prevBets) =>
              prevBets.map((b) => {
                if (b.roundId === settled324.id && b.status === 'pending') {
                  const won = b.side === settled324.verdict;
                  if (won) {
                    setBalance((bal) => parseFloat((bal + b.amount * b.multiplier).toFixed(2)));
                  }
                  return { ...b, status: won ? 'won' : 'lost' };
                }
                return b;
              })
            );

            // Keep the selected round pointing to the latest live one
            setSelectedRoundId(live326.id);

            return [settled324, locked325, live326];
          });
          return 300; // Reset to 5 minutes
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [spot]);

  // Format time (e.g. 298 -> "4:58")
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const amount = parseFloat(amountRaw) || 0;
  const activeRound = rounds.find((r) => r.id === selectedRoundId) || rounds[2];
  const canSubmit = amount > 0 && amount <= balance && activeRound.status === 'live';

  const selectPct = (pct: number) => {
    setAmountRaw(((balance * pct) / 100).toFixed(2));
  };

  const handleConfirm = () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setTxSuccess(false);

    // Simulate blockchain submission
    setTimeout(() => {
      setBalance((prev) => parseFloat((prev - amount).toFixed(2)));
      const newBet: Bet = {
        roundId: selectedRoundId,
        side: betSide,
        amount: amount,
        multiplier: betSide === 'up' ? activeRound.upMultiplier : activeRound.downMultiplier,
        status: 'pending',
      };
      setMyBets((prev) => [newBet, ...prev]);
      setIsSubmitting(false);
      setTxSuccess(true);

      // Hide success notification after 3s
      setTimeout(() => setTxSuccess(false), 3000);
    }, 1200);
  };

  const mono = { fontFamily: 'var(--font-mono)' };

  return (
    <div className="flex flex-col h-full bg-surface-primary text-[12px] overflow-hidden select-none">
      
      {/* Upper header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-text-secondary font-bold text-[13px]">{underlying} Prediction</span>
          <span className="text-bullish-green font-extrabold text-[13px] tracking-tight" style={mono}>
            ${spot.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </span>
          <span className="px-1.5 py-0.5 rounded-[4px] text-[10px] font-semibold bg-surface-hover border border-border-subtle text-text-tertiary">
            Rounds: 5m
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('trade')}
            className={`px-2.5 py-1 rounded-[6px] font-medium transition-colors ${
              activeTab === 'trade'
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            Predict
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`px-2.5 py-1 rounded-[6px] font-medium flex items-center gap-1 transition-colors ${
              activeTab === 'history'
                ? 'bg-surface-hover text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            <IconHistory size={12} />
            History ({myBets.length})
          </button>
        </div>
      </div>

      {/* Main body split/stack */}
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden min-h-0">
        
        {/* LEFT COLUMN: Horizontal Rounds timeline */}
        <div className="flex-1 flex flex-col items-center justify-center p-3 border-r border-border-subtle bg-[#08080f]/40 min-h-0 overflow-y-auto">
          
          <div className="w-full flex items-center justify-between mb-3 px-1">
            <span className="text-[11px] font-semibold text-text-tertiary tracking-wide uppercase">Rounds Timeline</span>
            <div className="flex items-center gap-1 text-[11px] text-brand-violet font-semibold" style={mono}>
              <span>Round {rounds[1].id} Settle:</span>
              <span className="bg-brand-violet/20 px-1.5 py-0.5 rounded text-[10px]">
                {formatTime(timeLeft)}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 w-full max-w-[620px]">
            {rounds.map((round, index) => {
              const isSelected = selectedRoundId === round.id;
              const isLive = round.status === 'live';
              const isLocked = round.id === rounds[1].id; // round 324 is currently settling
              
              let statusLabel = 'EXPIRED';
              let badgeColor = 'bg-surface-hover text-text-tertiary border-border-subtle';
              if (isLive) {
                statusLabel = 'ACTIVE';
                badgeColor = 'bg-brand-violet/20 text-brand-violet border-brand-violet/30';
              } else if (isLocked) {
                statusLabel = 'SETTLING';
                badgeColor = 'bg-warning/20 text-warning border-warning/30';
              }

              // Determine verdict color
              const isUpVerdict = round.verdict === 'up';
              const verdictBg = round.verdict 
                ? (isUpVerdict ? 'bg-bullish-green/10 text-bullish-green' : 'bg-bearish-red/10 text-bearish-red') 
                : '';

              return (
                <div
                  key={round.id}
                  onClick={() => {
                    if (round.status === 'live') {
                      setSelectedRoundId(round.id);
                    }
                  }}
                  className={`relative rounded-[16px] border flex flex-col p-3 transition-all select-none ${
                    round.status === 'live' ? 'cursor-pointer hover:border-brand-violet/50' : 'opacity-80'
                  } ${
                    isSelected
                      ? 'border-brand-violet bg-[#121324]/40 shadow-[0_0_15px_rgba(128,125,254,0.15)]'
                      : 'border-border-subtle bg-surface-card'
                  }`}
                >
                  {/* Card top */}
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] text-text-tertiary font-bold">#{round.id}</span>
                    <span className={`px-1.5 py-0.5 rounded-[4px] text-[8px] font-bold border uppercase ${badgeColor}`}>
                      {statusLabel}
                    </span>
                  </div>

                  {/* Chevrons Layout */}
                  <div className="flex flex-col gap-2 relative py-1">
                    
                    {/* UP CHEVRON CARD */}
                    <div className="relative overflow-hidden rounded-[8px] border border-border-subtle">
                      <svg viewBox="0 0 200 70" className="w-full h-auto block">
                        <defs>
                          <linearGradient id="upGrad" x1="0" y1="1" x2="0" y2="0">
                            <stop offset="0%" stopColor="rgba(11,153,129,0.02)" />
                            <stop offset="100%" stopColor="rgba(11,153,129,0.15)" />
                          </linearGradient>
                        </defs>
                        {/* Custom House top pointing UP */}
                        <path 
                          d="M 5,25 Q 5,20 9,18 L 93,2 Q 100,0 107,2 L 191,18 Q 195,20 195,25 L 195,65 Q 195,68 191,68 L 9,68 Q 5,68 5,65 Z" 
                          fill="url(#upGrad)" 
                          stroke={isLive && betSide === 'up' && isSelected ? '#0b9981' : 'rgba(255,255,255,0.04)'}
                          strokeWidth={2}
                        />
                      </svg>
                      {/* Overlay content */}
                      <div className="absolute inset-0 flex flex-col justify-center items-center text-center p-1 pointer-events-none">
                        <span className="text-bullish-green font-extrabold text-[11px] flex items-center gap-0.5">
                          <IconArrowUp size={10} stroke={3} />
                          UP
                        </span>
                        <span className="text-text-primary text-[12px] font-bold" style={mono}>
                          {round.upMultiplier}x Payout
                        </span>
                        <span className="text-[9px] text-text-tertiary">
                          Pool: {round.upPool} {underlying}
                        </span>
                      </div>
                    </div>

                    {/* DOWN CHEVRON CARD */}
                    <div className="relative overflow-hidden rounded-[8px] border border-border-subtle">
                      <svg viewBox="0 0 200 70" className="w-full h-auto block">
                        <defs>
                          <linearGradient id="downGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="rgba(242,53,70,0.02)" />
                            <stop offset="100%" stopColor="rgba(242,53,70,0.15)" />
                          </linearGradient>
                        </defs>
                        {/* Custom House top pointing DOWN */}
                        <path 
                          d="M 5,5 Q 5,2 9,2 L 191,2 Q 195,2 195,5 L 195,45 Q 195,50 191,52 L 107,68 Q 100,70 93,68 L 9,52 Q 5,50 5,45 Z" 
                          fill="url(#downGrad)" 
                          stroke={isLive && betSide === 'down' && isSelected ? '#f23546' : 'rgba(255,255,255,0.04)'}
                          strokeWidth={2}
                        />
                      </svg>
                      {/* Overlay content */}
                      <div className="absolute inset-0 flex flex-col justify-center items-center text-center p-1 pointer-events-none">
                        <span className="text-[9px] text-text-tertiary">
                          Pool: {round.downPool} {underlying}
                        </span>
                        <span className="text-text-primary text-[12px] font-bold" style={mono}>
                          {round.downMultiplier}x Payout
                        </span>
                        <span className="text-bearish-red font-extrabold text-[11px] flex items-center gap-0.5">
                          <IconArrowDown size={10} stroke={3} />
                          DOWN
                        </span>
                      </div>
                    </div>

                  </div>

                  {/* Card bottom: metrics */}
                  <div className="mt-2 pt-2 border-t border-border-subtle/40 flex flex-col gap-1 text-[10px]">
                    {round.status === 'expired' ? (
                      <>
                        <div className="flex justify-between text-text-quaternary">
                          <span>Locked:</span>
                          <span style={mono}>${round.lockedPrice?.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Closed:</span>
                          <span 
                            className={`font-semibold ${round.verdict ? (isUpVerdict ? 'text-bullish-green' : 'text-bearish-red') : 'text-text-secondary'}`}
                            style={mono}
                          >
                            {round.closePrice ? `$${round.closePrice.toFixed(2)}` : 'Settle...'}
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="flex items-center justify-between text-text-quaternary">
                          <span>Status:</span>
                          <span className="text-text-secondary">Open to bets</span>
                        </div>
                        <div className="flex items-center gap-1 text-brand-violet">
                          <IconLock size={10} />
                          <span>Locks in {formatTime(timeLeft)}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 flex items-center gap-2 text-text-quaternary text-[10px] max-w-[620px] w-full px-1">
            <IconInfoCircle size={12} className="shrink-0" />
            <span>Select the ACTIVE card (#325) to place a prediction. Expired/Settling rounds show historical pricing outcomes.</span>
          </div>

        </div>

        {/* RIGHT COLUMN: Bet Ticket or History */}
        <div className="w-full md:w-[280px] shrink-0 border-t md:border-t-0 md:border-l border-border-subtle bg-surface-primary flex flex-col min-h-0">
          {activeTab === 'trade' ? (
            <div className="flex flex-col flex-1 p-3 overflow-y-auto">
              
              {/* Ticket header */}
              <div className="flex items-center justify-between mb-2 pb-2 border-b border-border-subtle">
                <div>
                  <span className="text-[10px] text-text-quaternary font-bold block">PLACING BET</span>
                  <span className="text-[12px] text-text-secondary font-bold" style={mono}>Round #{selectedRoundId}</span>
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-[9px] text-text-quaternary font-medium">LOCKS IN</span>
                  <span className="text-[12px] font-bold text-brand-violet" style={mono}>
                    {activeRound.status === 'live' ? formatTime(timeLeft) : 'LOCKED'}
                  </span>
                </div>
              </div>

              {/* UP / DOWN position pills */}
              <div className="grid grid-cols-2 gap-2 mb-3 bg-surface-card p-1 rounded-[8px] border border-border-subtle">
                <button
                  disabled={activeRound.status !== 'live'}
                  onClick={() => setBetSide('up')}
                  className={`py-1.5 text-[11px] font-bold rounded-[6px] transition-all ${
                    betSide === 'up'
                      ? 'bg-bullish-green text-[#05050f]'
                      : 'text-text-tertiary hover:text-text-secondary'
                  } disabled:opacity-50`}
                >
                  UP ({activeRound.upMultiplier}x)
                </button>
                <button
                  disabled={activeRound.status !== 'live'}
                  onClick={() => setBetSide('down')}
                  className={`py-1.5 text-[11px] font-bold rounded-[6px] transition-all ${
                    betSide === 'down'
                      ? 'bg-bearish-red text-[#05050f]'
                      : 'text-text-tertiary hover:text-text-secondary'
                  } disabled:opacity-50`}
                >
                  DOWN ({activeRound.downMultiplier}x)
                </button>
              </div>

              {/* Price metrics */}
              <div className="flex flex-col gap-1.5 p-2.5 rounded-[8px] bg-surface-card border border-border-subtle mb-3">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-text-tertiary">Current Spot Price:</span>
                  <span className="text-text-primary font-semibold" style={mono}>
                    ${spot.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-text-tertiary">Payout Multiplier:</span>
                  <span 
                    className={`font-bold ${betSide === 'up' ? 'text-bullish-green' : 'text-bearish-red'}`} 
                    style={mono}
                  >
                    {betSide === 'up' ? activeRound.upMultiplier : activeRound.downMultiplier}x
                  </span>
                </div>
              </div>

              {/* Balance */}
              <div className="flex items-center justify-between mb-1.5 text-text-tertiary">
                <span>Enter Amount ({underlying})</span>
                <span className="text-[11px]" style={mono}>
                  Bal: ${balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              </div>

              {/* Input field */}
              <div className="flex items-center bg-surface-card rounded-[8px] px-3 py-2 border border-border-subtle gap-2 mb-2 focus-within:border-brand-violet">
                <span className="text-text-quaternary font-bold">$</span>
                <input
                  type="number"
                  disabled={activeRound.status !== 'live'}
                  value={amountRaw}
                  onChange={(e) => setAmountRaw(e.target.value)}
                  placeholder="0.00"
                  className="flex-1 bg-transparent text-[14px] text-text-primary outline-none font-bold placeholder:text-text-quaternary"
                  style={mono}
                />
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-secondary border border-border-subtle uppercase">
                  USDT
                </span>
              </div>

              {/* Percentage short-cuts */}
              <div className="grid grid-cols-5 gap-1 mb-3">
                {[10, 25, 50, 75].map((pct) => (
                  <button
                    key={pct}
                    disabled={activeRound.status !== 'live'}
                    onClick={() => selectPct(pct)}
                    className="py-1 rounded bg-surface-card border border-border-subtle hover:bg-surface-hover text-[10px] text-text-tertiary hover:text-text-secondary"
                  >
                    {pct}%
                  </button>
                ))}
                <button
                  disabled={activeRound.status !== 'live'}
                  onClick={() => selectPct(100)}
                  className="py-1 rounded bg-surface-card border border-border-subtle hover:bg-surface-hover text-[10px] font-semibold text-brand-violet"
                >
                  MAX
                </button>
              </div>

              {/* Potential payout metrics */}
              <AnimatePresence>
                {amount > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden mb-3"
                  >
                    <div className="rounded-[8px] bg-brand-violet/5 border border-brand-violet/15 p-2.5 flex flex-col gap-1 text-[11px]">
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Potential Payout:</span>
                        <span className="text-bullish-green font-extrabold" style={mono}>
                          ${(amount * (betSide === 'up' ? activeRound.upMultiplier : activeRound.downMultiplier)).toFixed(2)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text-tertiary">Net Profit:</span>
                        <span className="text-text-secondary font-semibold" style={mono}>
                          ${(amount * ((betSide === 'up' ? activeRound.upMultiplier : activeRound.downMultiplier) - 1)).toFixed(2)}
                        </span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Submit CTA */}
              <button
                onClick={handleConfirm}
                disabled={!canSubmit || isSubmitting}
                className="w-full py-2.5 font-bold rounded-[8px] text-[12px] tracking-wide uppercase transition-all flex items-center justify-center gap-1.5 cursor-pointer mt-auto"
                style={{
                  backgroundColor: canSubmit
                    ? (betSide === 'up' ? 'var(--color-bullish-green)' : 'var(--color-bearish-red)')
                    : 'var(--color-surface-hover)',
                  color: canSubmit ? '#000000' : 'var(--color-text-quaternary)',
                }}
              >
                {isSubmitting ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-current" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    SUBMITTING...
                  </>
                ) : (
                  <>
                    CONFIRM PREDICT {betSide.toUpperCase()}
                  </>
                )}
              </button>

              {/* Mini feedback banner */}
              <AnimatePresence>
                {txSuccess && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="mt-2 p-2 rounded-[6px] bg-bullish-green/10 border border-bullish-green/20 text-bullish-green text-[10px] text-center flex items-center justify-center gap-1"
                  >
                    <IconCheck size={12} stroke={3} />
                    <span>Predict position placed successfully!</span>
                  </motion.div>
                )}
              </AnimatePresence>

            </div>
          ) : (
            // HISTORY TAB
            <div className="flex flex-col flex-1 p-3 overflow-y-auto">
              <span className="text-[10px] font-bold text-text-quaternary mb-2 block uppercase">My Predict Position History</span>
              {myBets.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-4 text-text-quaternary">
                  <IconTrophy size={28} className="mb-1 opacity-40 text-text-tertiary" />
                  <span>No prediction positions placed yet. Enter a prediction in the Predict tab.</span>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {myBets.map((bet, i) => {
                    let statusColor = 'text-text-tertiary';
                    let statusLabel = 'PENDING';
                    
                    if (bet.status === 'won') {
                      statusColor = 'text-bullish-green';
                      statusLabel = 'WON';
                    } else if (bet.status === 'lost') {
                      statusColor = 'text-bearish-red';
                      statusLabel = 'LOST';
                    }

                    return (
                      <div key={i} className="p-2.5 rounded-[8px] bg-surface-card border border-border-subtle flex flex-col gap-1 text-[11px]">
                        <div className="flex justify-between items-center">
                          <span className="font-bold text-text-secondary" style={mono}>Round #{bet.roundId}</span>
                          <span className={`font-extrabold ${statusColor}`}>{statusLabel}</span>
                        </div>
                        <div className="flex justify-between text-text-tertiary text-[10px]">
                          <span>Prediction Side:</span>
                          <span className={bet.side === 'up' ? 'text-bullish-green' : 'text-bearish-red'} style={mono}>
                            {bet.side === 'up' ? 'UP' : 'DOWN'} ({bet.multiplier}x)
                          </span>
                        </div>
                        <div className="flex justify-between text-text-tertiary text-[10px]">
                          <span>Amount / Return:</span>
                          <span style={mono} className="text-text-primary">
                            ${bet.amount.toFixed(2)} → {bet.status === 'won' ? `+$${(bet.amount * bet.multiplier).toFixed(2)}` : bet.status === 'lost' ? '-$0.00' : 'Pending'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
