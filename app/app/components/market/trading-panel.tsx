import { useState, useRef, useEffect, useCallback } from 'react';
import {
  motion,
  AnimatePresence,
  useMotionValue,
  animate,
} from 'framer-motion';
import {
  IconCheck,
  IconChevronDown,
  IconLock,
  IconPlus,
  IconSettings,
  IconX,
} from '@tabler/icons-react';

const MIN_LEV = 1,
  MAX_LEV = 50,
  STEPS = MAX_LEV - MIN_LEV;
const LABEL_MARKS = [1, 3, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
const barH = (step: number) => 5 + (step / STEPS) * 27; // 5px → 32px
const UP_PRICE = 97;
const DOWN_PRICE = 4;
const BALANCE = 842.36;

type Direction = 'buy' | 'sell';
type ContractSide = 'up' | 'down';
type OrderType = 'market' | 'limit' | 'pro';

function LeverageSlider({
  value,
  onChange,
  tone,
}: {
  value: number;
  onChange: (v: number) => void;
  tone: 'green' | 'red' | 'violet';
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbX = useMotionValue(0);
  const dragging = useRef(false);
  const [showHandle, setShowHandle] = useState(false);
  const accent =
    tone === 'green'
      ? 'var(--color-bullish-green)'
      : tone === 'red'
        ? 'var(--color-bearish-red)'
        : 'var(--color-brand-violet)';
  const soft =
    tone === 'green'
      ? 'rgba(11,153,129,0.18)'
      : tone === 'red'
        ? 'rgba(242,53,70,0.18)'
        : 'rgba(128,125,254,0.18)';

  const getW = () => trackRef.current?.clientWidth ?? 0;
  const levToX = (lev: number) => ((lev - MIN_LEV) / STEPS) * getW();
  const xToLev = (x: number) =>
    Math.round(Math.max(0, Math.min(1, x / (getW() || 1))) * STEPS) + MIN_LEV;

  useEffect(() => {
    if (!dragging.current) thumbX.set(levToX(value));
  });

  const springTo = useCallback(
    (lev: number) => {
      onChange(lev);
      animate(thumbX, levToX(lev), {
        type: 'spring',
        stiffness: 600,
        damping: 38,
        mass: 0.4,
      });
    },
    [onChange],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  const handleThumbDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    dragging.current = true;
    setShowHandle(true);
    const origin = { clientX: e.clientX, x: thumbX.get() };

    const onMove = (e: PointerEvent) => {
      const nx = Math.max(
        0,
        Math.min(getW(), origin.x + e.clientX - origin.clientX),
      );
      thumbX.set(nx);
      onChange(xToLev(nx));
    };
    const onUp = (e: PointerEvent) => {
      dragging.current = false;
      setShowHandle(false);
      const nx = Math.max(
        0,
        Math.min(getW(), origin.x + e.clientX - origin.clientX),
      );
      springTo(xToLev(nx));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Major bars sit at each LABEL_MARK position
  const majors = LABEL_MARKS.map((mark, i) => ({
    pos: (mark - MIN_LEV) / STEPS,
    h: barH(mark - MIN_LEV),
    active: mark <= value,
    step: i,
  }));

  // 3 minor bars evenly spaced between each pair of major bars
  const minors: { pos: number; h: number }[] = [];
  for (let i = 0; i < LABEL_MARKS.length - 1; i++) {
    const aStep = (LABEL_MARKS[i] ?? MIN_LEV) - MIN_LEV;
    const bStep = (LABEL_MARKS[i + 1] ?? MAX_LEV) - MIN_LEV;
    for (let j = 1; j <= 3; j++) {
      const frac = j / 4;
      const step = aStep + frac * (bStep - aStep);
      minors.push({
        pos: step / STEPS,
        h: barH(aStep) + frac * (barH(bStep) - barH(aStep)),
      });
    }
  }

  return (
    <div>
      <div className="flex items-baseline gap-1 mb-1">
        <p className="text-[11px] font-medium text-text-tertiary uppercase tracking-widest">
          Leverage
        </p>
        <motion.span
          key={value}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className="ml-1.5 text-[20px] font-semibold text-text-primary leading-none"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {value}
        </motion.span>
        <span
          className="text-[13px] font-light text-text-secondary"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          x
        </span>
      </div>

      <div
        ref={trackRef}
        className="relative select-none"
        style={{ height: 58, cursor: 'pointer' }}
        onPointerEnter={() => setShowHandle(true)}
        onPointerLeave={() => {
          if (!dragging.current) setShowHandle(false);
        }}
        onClick={(e) => {
          const rect = trackRef.current!.getBoundingClientRect();
          springTo(xToLev(e.clientX - rect.left));
        }}
      >
        {/* Bar + tick zone */}
        <div style={{ position: 'absolute', inset: '0 0 18px 0' }}>
          {/* Major bars */}
          {majors.map(({ pos, h, active }, i) => (
            <div
              key={`mj${i}`}
              style={{
                position: 'absolute',
                left: `${pos * 100}%`,
                bottom: 6,
                width: 2,
                height: h,
                transform: 'translateX(-1px)',
                backgroundColor: active ? accent : 'rgba(255,255,255,0.08)',
                pointerEvents: 'none',
                transition: 'background-color 0.1s',
              }}
            />
          ))}

          {/* Minor bars */}
          {minors.map(({ pos, h }, i) => (
            <div
              key={`mn${i}`}
              style={{
                position: 'absolute',
                left: `${pos * 100}%`,
                bottom: 6,
                width: 1.5,
                height: h,
                transform: 'translateX(-0.75px)',
                backgroundColor: 'rgba(255,255,255,0.08)',
                opacity: 0.5,
                pointerEvents: 'none',
              }}
            />
          ))}

          {/* Major ticks */}
          {majors.map(({ pos, active }, i) => (
            <div
              key={`tmj${i}`}
              style={{
                position: 'absolute',
                left: `${pos * 100}%`,
                bottom: 0,
                width: 1.5,
                height: 5,
                transform: 'translateX(-0.75px)',
                backgroundColor: active ? accent : 'rgba(255,255,255,0.8)',
                opacity: active ? 0.7 : 0.8,
                pointerEvents: 'none',
              }}
            />
          ))}

          {/* Minor ticks */}
          {minors.map(({ pos }, i) => (
            <div
              key={`tmn${i}`}
              style={{
                position: 'absolute',
                left: `${pos * 100}%`,
                bottom: 0,
                width: 1.5,
                height: 5,
                transform: 'translateX(-0.75px)',
                backgroundColor: 'rgba(255,255,255,0.08)',
                opacity: 0.4,
                pointerEvents: 'none',
              }}
            />
          ))}

          {/* Draggable thumb */}
          <motion.div
            onPointerDown={handleThumbDown}
            style={{
              position: 'absolute',
              left: 0,
              bottom: 6,
              x: thumbX,
              width: 12,
              height: 50,
              translateX: '-6px',
              backgroundColor: 'transparent',
              cursor: 'grab',
              zIndex: 10,
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: 2,
                transform: 'translateX(-1px)',
                backgroundColor: accent,
              }}
            />
          </motion.div>

          {/* Drag handle grip — appears on drag */}
          <AnimatePresence>
            {showHandle && (
              <motion.div
                initial={{ opacity: 0, scale: 0.7, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.7, y: 6 }}
                transition={{
                  type: 'spring',
                  stiffness: 500,
                  damping: 28,
                  mass: 0.4,
                }}
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  x: thumbX,
                  translateX: '-50%',
                  pointerEvents: 'none',
                  zIndex: 20,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                }}
              >
                <div
                  style={{
                    width: 22,
                    height: 28,
                    backgroundColor: soft,
                    borderRadius: 6,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 4px)',
                    gridTemplateRows: 'repeat(3, 4px)',
                    gap: 2,
                    placeContent: 'center',
                    boxShadow:
                      'rgba(0,0,0,0.25) 0px 2px 10px',
                  }}
                >
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: '50%',
                        backgroundColor: accent,
                        opacity: 0.7,
                      }}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Snap labels */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 4,
            right: 4,
            height: 18,
          }}
        >
          {LABEL_MARKS.map((lev) => (
            <button
              key={lev}
              onClick={(e) => {
                e.stopPropagation();
                springTo(lev);
              }}
              style={{
                position: 'absolute',
                left: `${((lev - MIN_LEV) / STEPS) * 100}%`,
                transform: 'translateX(-50%)',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                fontWeight: lev === value ? 600 : 500,
                color: lev === value ? accent : 'rgba(255,255,255,0.35)',
                padding: 0,
                lineHeight: 1,
                transition: 'color 0.15s',
              }}
            >
              {lev}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const TradingPanel = () => {
  const [direction, setDirection] = useState<Direction>('buy');
  const [contractSide, setContractSide] = useState<ContractSide>('up');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [showProMenu, setShowProMenu] = useState(false);
  const [pctSelected, setPctSelected] = useState<number | null>(null);
  const [takeProfitEnabled, setTakeProfitEnabled] = useState(false);
  const [walkBook, setWalkBook] = useState(true);
  const [fillKill, setFillKill] = useState(false);
  const [leverageEnabled, setLeverageEnabled] = useState(false);
  const [leverage, setLeverage] = useState(1);
  const [amount, setAmount] = useState('');
  const [limitPrice, setLimitPrice] = useState(contractSide === 'up' ? UP_PRICE : DOWN_PRICE);
  const [slip, setSlip] = useState(3);
  const [retries, setRetries] = useState(3);

  const pctOptions = [5, 20, 50];
  const actionPrice = contractSide === 'up' ? UP_PRICE : DOWN_PRICE;
  const sellPrice = Math.max(1, actionPrice - 2);
  const shownCents = direction === 'buy' ? actionPrice : sellPrice;
  const amountNum = Number(amount) || 0;
  const shares = shownCents > 0 ? amountNum / (shownCents / 100) : 0;
  const exposure = leverageEnabled ? amountNum * leverage : amountNum;
  const accent =
    leverageEnabled && direction === 'sell'
      ? 'var(--color-bearish-red)'
      : 'var(--color-bullish-green)';
  const mutedAction = amountNum <= 0;
  const directionLabels = leverageEnabled
    ? ({ buy: 'Long', sell: 'Short' } as const)
    : ({ buy: 'Buy', sell: 'Sell' } as const);
  const submitLabel = `${directionLabels[direction].toUpperCase()} ${contractSide.toUpperCase()}`;

  const selectPct = (pct: number) => {
    setPctSelected(pct);
    setAmount(((BALANCE * pct) / 100).toFixed(2));
  };

  const updateContractSide = (side: ContractSide) => {
    setContractSide(side);
    setLimitPrice(side === 'up' ? UP_PRICE : DOWN_PRICE);
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface-primary text-[12px]">
      <div className="flex h-10 shrink-0 items-center border-b border-border-subtle px-3">
        <div className="rounded-[6px] bg-surface-card px-3 py-1.5 text-[12px] font-semibold text-text-primary">
          Execution
        </div>
        <button className="ml-2 flex h-7 w-7 items-center justify-center rounded-[6px] bg-surface-card text-[18px] leading-none text-text-tertiary hover:text-text-primary">
          <IconX size={15} stroke={2.25} />
        </button>
        <button className="ml-1 flex h-7 w-7 items-center justify-center rounded-[6px] bg-surface-card text-[18px] leading-none text-text-tertiary hover:text-text-primary">
          <IconPlus size={15} stroke={2.25} />
        </button>
      </div>

      <div className="grid grid-cols-2 border-b border-border-subtle px-5">
        {(['buy', 'sell'] as const).map((side) => (
          <button
            key={side}
            onClick={() => setDirection(side)}
            className={`relative h-12 text-left text-[15px] font-semibold transition-colors ${
              direction === side ? 'text-text-primary' : 'text-text-quaternary hover:text-text-secondary'
            }`}
            style={{
              color:
                direction === side
                  ? side === 'sell' && leverageEnabled
                    ? 'var(--color-bearish-red)'
                    : 'var(--color-bullish-green)'
                  : undefined,
            }}
          >
            {directionLabels[side]}
            {direction === side && (
              <span
                className="absolute bottom-0 left-0 h-[2px] w-16 rounded-full"
                style={{ backgroundColor: side === 'sell' && leverageEnabled ? 'var(--color-bearish-red)' : 'var(--color-bullish-green)' }}
              />
            )}
          </button>
        ))}
      </div>

      <div className="relative flex items-center gap-0 border-b border-border-subtle px-5 py-2">
        {(['market', 'limit'] as const).map((type) => (
          <button
            key={type}
            onClick={() => setOrderType(type)}
            className={`relative h-9 flex-1 text-[15px] font-semibold transition-colors ${
              orderType === type ? 'text-text-primary' : 'text-text-quaternary hover:text-text-secondary'
            }`}
          >
            {type.charAt(0).toUpperCase() + type.slice(1)}
            {orderType === type && (
              <span className="absolute bottom-0 left-1/2 h-[2px] w-24 -translate-x-1/2 rounded-full bg-brand-violet" />
            )}
          </button>
        ))}
        <button
          onClick={() => {
            setOrderType('pro');
            setShowProMenu((v) => !v);
          }}
          className={`ml-3 flex h-9 items-center gap-1 px-1 text-[15px] font-semibold transition-colors ${
            orderType === 'pro' ? 'text-text-primary' : 'text-text-quaternary hover:text-text-secondary'
          }`}
        >
          PRO
          <IconChevronDown
            size={14}
            stroke={2.5}
            className={`transition-transform ${showProMenu ? 'rotate-180' : ''}`}
          />
        </button>
        <AnimatePresence>
          {showProMenu && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="absolute right-4 top-12 z-20 w-[270px] rounded-[8px] border border-border-subtle bg-surface-primary p-2 shadow-2xl"
            >
              {[
                ['Trigger', 'Conditional order that arms at a target price'],
                ['Trailing stop', 'Stop that follows the market by a fixed offset'],
                ['CTF split', 'Convert pUSD into matched YES+NO pairs'],
              ].map(([title, body]) => (
                <button
                  key={title}
                  onClick={() => setShowProMenu(false)}
                  className="w-full rounded-[6px] px-3 py-2 text-left hover:bg-surface-card"
                >
                  <div className="text-[13px] font-semibold text-text-primary">{title}</div>
                  <div className="mt-1 text-[11px] text-text-tertiary">{body}</div>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-y-auto overflow-x-hidden px-5 py-4">
        <div className="grid grid-cols-2 overflow-hidden rounded-[6px] bg-surface-card">
          {(['up', 'down'] as const).map((side) => {
            const active = contractSide === side;
            const cents = side === 'up' ? UP_PRICE : DOWN_PRICE;
            return (
              <button
                key={side}
                onClick={() => updateContractSide(side)}
                className="flex h-[58px] items-center justify-between px-6 text-[17px] font-semibold uppercase transition-colors"
                style={{
                  backgroundColor: active
                    ? side === 'up'
                      ? 'var(--color-bullish-green)'
                      : 'var(--color-bearish-red)'
                    : 'transparent',
                  color: active ? '#fff' : 'var(--color-text-tertiary)',
                }}
              >
                <span>{side}</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>{cents.toFixed(1)}¢</span>
              </button>
            );
          })}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between text-[11px] text-text-tertiary">
            <span>0%</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>${amountNum.toFixed(2)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={pctSelected ?? 0}
            onChange={(e) => selectPct(Number(e.target.value))}
            className="w-full accent-white"
          />
          <div className="mt-1 grid grid-cols-4 text-center text-[10px] text-text-quaternary">
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>

        <div className="grid grid-cols-[repeat(4,minmax(0,1fr))_32px] gap-2">
          {pctOptions.map((pct) => (
            <button
              key={pct}
              onClick={() => selectPct(pct)}
              className={`h-10 rounded-[6px] border text-[13px] transition-colors ${
                pctSelected === pct
                  ? 'border-brand-violet bg-brand-violet/20 text-text-primary'
                  : 'border-border-subtle bg-surface-card text-text-quaternary hover:text-text-secondary'
              }`}
            >
              ${pct}
            </button>
          ))}
          <button
            onClick={() => selectPct(100)}
            className={`h-10 rounded-[6px] border text-[13px] transition-colors ${
              pctSelected === 100
                ? 'border-brand-violet bg-brand-violet/20 text-text-primary'
                : 'border-border-subtle bg-surface-card text-text-quaternary hover:text-text-secondary'
            }`}
          >
            MAX
          </button>
          <button className="h-10 rounded-[6px] border border-border-subtle bg-surface-card text-[17px] text-text-tertiary hover:text-text-primary">
            <IconSettings size={17} stroke={2} className="mx-auto" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-widest text-text-tertiary">
              <span>Amount</span>
              <span>${amountNum.toFixed(0)}</span>
            </div>
            <div className="flex h-[58px] items-center gap-3 rounded-[6px] bg-surface-card px-4">
              <span className="text-[19px] text-text-tertiary">$</span>
              <input
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setPctSelected(null);
                }}
                inputMode="decimal"
                placeholder="0"
                className="min-w-0 flex-1 bg-transparent text-[21px] text-text-primary outline-none placeholder:text-text-tertiary"
                style={{ fontFamily: 'var(--font-mono)' }}
              />
            </div>
          </label>
          <label className="block">
            <div className="mb-2 text-[11px] uppercase tracking-widest text-text-tertiary">
              Shares
            </div>
            <div className="flex h-[58px] items-center rounded-[6px] bg-surface-card px-4 text-[21px] text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
              {shares > 0 ? shares.toFixed(2) : '0'}
            </div>
          </label>
        </div>

        <div className="flex items-center justify-between rounded-[8px] border border-border-subtle bg-surface-primary px-3 py-2">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-text-tertiary">
              Leverage
            </div>
            <div className="mt-1 text-[11px] text-text-quaternary">
              {leverageEnabled ? `${directionLabels[direction]} exposure is active` : 'Spot binary execution'}
            </div>
          </div>
          <button
            onClick={() => {
              setLeverageEnabled((v) => !v);
              if (!leverageEnabled && leverage < 2) setLeverage(3);
            }}
            className={`relative h-7 w-12 rounded-full transition-colors ${
              leverageEnabled ? 'bg-brand-violet' : 'bg-surface-hover'
            }`}
          >
            <span
              className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-transform ${
                leverageEnabled ? 'translate-x-[22px]' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        <AnimatePresence>
          {leverageEnabled && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <LeverageSlider
                value={leverage}
                onChange={setLeverage}
                tone={direction === 'sell' ? 'red' : 'green'}
              />
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                <Metric label="Exposure" value={`$${exposure.toFixed(2)}`} />
                <Metric label="Est. liq" value={direction === 'sell' ? '112.4¢' : '2.8¢'} />
                <Metric label="Borrow" value="0.18%" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {orderType === 'limit' && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="rounded-[10px] border border-border-subtle bg-surface-primary p-4"
            >
              <div className="mb-3 text-[11px] uppercase tracking-widest text-text-tertiary">
                Limit price
              </div>
              <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-4">
                <span className="text-[16px] text-brand-violet">-1%</span>
                <button
                  onClick={() => setLimitPrice((p) => Math.max(1, p - 1))}
                  className="text-[22px] text-text-tertiary hover:text-text-primary"
                >
                  -
                </button>
                <span className="text-[24px] text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
                  {limitPrice}
                  <span className="ml-2 text-[15px] text-text-tertiary">¢</span>
                </span>
                <button
                  onClick={() => setLimitPrice((p) => Math.min(99, p + 1))}
                  className="text-[22px] text-text-tertiary hover:text-text-primary"
                >
                  +
                </button>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {['Best Bid', 'Mid', 'Best Offer'].map((label) => (
                  <button
                    key={label}
                    className="h-8 rounded-[5px] bg-brand-violet/10 text-[12px] text-text-secondary hover:bg-brand-violet/20"
                  >
                    {label} <IconLock size={12} stroke={2} className="ml-1 inline text-text-quaternary" />
                  </button>
                ))}
              </div>
              <div className="mt-3 text-[11px] text-text-quaternary">
                Staged locally. Keeper execution comes after limit orders ship.
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setTakeProfitEnabled(!takeProfitEnabled)}
            className={`h-7 w-7 rounded-[6px] border transition-colors ${
              takeProfitEnabled ? 'border-brand-violet bg-brand-violet text-white' : 'border-border-default bg-surface-primary'
            }`}
          >
            {takeProfitEnabled ? <IconCheck size={16} stroke={2.5} className="mx-auto" /> : null}
          </button>
          <button
            onClick={() => setTakeProfitEnabled(!takeProfitEnabled)}
            className="border-b border-dotted border-text-tertiary text-[15px] font-semibold text-text-primary"
          >
            Take Profit / Stop Loss
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <ToggleLine label="Fill and Kill" checked={fillKill} onClick={() => setFillKill((v) => !v)} />
          <ToggleLine label="Walk the Book" checked={walkBook} onClick={() => setWalkBook((v) => !v)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Stepper label="Max Slip" suffix="¢" value={slip} setValue={setSlip} />
          <Stepper label="Retries" value={retries} setValue={setRetries} />
        </div>
      </div>

      <div className="shrink-0 px-5 pb-5">
        <button
          className="h-[72px] w-full rounded-[10px] text-[17px] font-bold uppercase tracking-widest text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            backgroundColor: mutedAction ? 'var(--color-surface-hover)' : accent,
          }}
          disabled={mutedAction}
        >
          {submitLabel}
          <span className="mx-2 text-text-tertiary">-</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {amountNum > 0 ? `$${amountNum.toFixed(2)}` : '0'}
          </span>
        </button>
      </div>
    </div>
  );
};

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[6px] bg-surface-card px-3 py-2">
      <div className="text-[9px] uppercase tracking-widest text-text-quaternary">
        {label}
      </div>
      <div className="mt-1 text-[12px] font-semibold text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
        {value}
      </div>
    </div>
  );
}

function ToggleLine({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-3 text-left">
      <IconChevronDown size={17} stroke={2.25} className="text-text-tertiary" />
      <span className="border-b border-dotted border-text-tertiary text-[14px] font-semibold text-text-primary">
        {label}
      </span>
      <span
        className={`ml-auto grid h-7 w-7 place-items-center rounded-[6px] ${
          checked ? 'bg-brand-violet text-white' : 'border border-border-default bg-surface-primary text-transparent'
        }`}
      >
        <IconCheck size={16} stroke={2.5} />
      </span>
    </button>
  );
}

function Stepper({
  label,
  value,
  setValue,
  suffix = '',
}: {
  label: string;
  value: number;
  setValue: (value: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-text-tertiary">{label}</span>
      <div className="flex items-center gap-4">
        <button
          onClick={() => setValue(Math.max(0, value - 1))}
          className="text-[18px] text-text-tertiary hover:text-text-primary"
        >
          -
        </button>
        <span className="min-w-10 text-center text-[18px] text-text-primary" style={{ fontFamily: 'var(--font-mono)' }}>
          {value}{suffix}
        </span>
        <button
          onClick={() => setValue(value + 1)}
          className="text-[18px] text-text-tertiary hover:text-text-primary"
        >
          +
        </button>
      </div>
    </div>
  );
}

export default TradingPanel;
