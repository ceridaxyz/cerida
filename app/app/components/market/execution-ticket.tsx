import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, animate, motion, useMotionValue } from 'framer-motion';
import { IconCheck } from '@tabler/icons-react';

const MIN_LEV = 1;
const MAX_LEV = 50;
const STEPS = MAX_LEV - MIN_LEV;
const LABEL_MARKS = [1, 3, 5, 10, 20, 30, 40, 50];
const UP_PRICE = 97;
const DOWN_PRICE = 4;
const BALANCE = 842.36;

type Direction = 'long' | 'short';
type ContractSide = 'up' | 'down';

function LeverageSlider({
  value,
  onChange,
  tone,
}: {
  value: number;
  onChange: (v: number) => void;
  tone: 'green' | 'red';
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbX = useMotionValue(0);
  const dragging = useRef(false);
  const [showHandle, setShowHandle] = useState(false);
  const accent =
    tone === 'green' ? 'var(--color-bullish-green)' : 'var(--color-bearish-red)';

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

    const onMove = (event: PointerEvent) => {
      const nx = Math.max(
        0,
        Math.min(getW(), origin.x + event.clientX - origin.clientX),
      );
      thumbX.set(nx);
      onChange(xToLev(nx));
    };
    const onUp = (event: PointerEvent) => {
      dragging.current = false;
      setShowHandle(false);
      const nx = Math.max(
        0,
        Math.min(getW(), origin.x + event.clientX - origin.clientX),
      );
      springTo(xToLev(nx));
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const marks = LABEL_MARKS.map((mark) => ({
    lev: mark,
    pos: (mark - MIN_LEV) / STEPS,
    active: mark <= value,
    h: 6 + ((mark - MIN_LEV) / STEPS) * 22,
  }));

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1">
        <span className="text-[10px] font-medium uppercase tracking-widest text-text-tertiary">
          Leverage
        </span>
        <motion.span
          key={value}
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          className="ml-1 text-[17px] font-semibold leading-none text-text-primary"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {value}
        </motion.span>
        <span
          className="text-[11px] text-text-secondary"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          x
        </span>
      </div>

      <div
        ref={trackRef}
        className="relative select-none"
        style={{ height: 46, cursor: 'pointer' }}
        onPointerEnter={() => setShowHandle(true)}
        onPointerLeave={() => {
          if (!dragging.current) setShowHandle(false);
        }}
        onClick={(e) => {
          const rect = trackRef.current!.getBoundingClientRect();
          springTo(xToLev(e.clientX - rect.left));
        }}
      >
        <div className="absolute inset-x-0 top-0 h-8">
          {marks.map((mark) => (
            <div
              key={mark.lev}
              className="absolute bottom-0 w-[2px] -translate-x-px"
              style={{
                left: `${mark.pos * 100}%`,
                height: mark.h,
                backgroundColor: mark.active ? accent : 'rgba(255,255,255,0.1)',
              }}
            />
          ))}

          <motion.div
            onPointerDown={handleThumbDown}
            style={{
              position: 'absolute',
              left: 0,
              bottom: 0,
              x: thumbX,
              width: 12,
              height: 32,
              translateX: '-6px',
              cursor: 'grab',
              zIndex: 10,
            }}
          >
            <div
              className="absolute inset-y-0 left-1/2 w-[2px] -translate-x-px"
              style={{ backgroundColor: accent }}
            />
          </motion.div>

          <AnimatePresence>
            {showHandle && (
              <motion.div
                initial={{ opacity: 0, scale: 0.8, y: 5 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.8, y: 5 }}
                className="pointer-events-none absolute top-0 z-20 h-5 w-5 -translate-x-1/2 rounded-[5px] border"
                style={{
                  x: thumbX,
                  borderColor: accent,
                  backgroundColor: 'var(--color-surface-card)',
                }}
              />
            )}
          </AnimatePresence>
        </div>

        <div className="absolute bottom-0 left-1 right-1 h-4">
          {marks.map((mark) => (
            <button
              key={mark.lev}
              onClick={(e) => {
                e.stopPropagation();
                springTo(mark.lev);
              }}
              className="absolute -translate-x-1/2 text-[9px]"
              style={{
                left: `${mark.pos * 100}%`,
                color: mark.lev === value ? accent : 'rgba(255,255,255,0.35)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {mark.lev}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ExecutionTicket() {
  const [direction, setDirection] = useState<Direction>('long');
  const [contractSide, setContractSide] = useState<ContractSide>('up');
  const [pctSelected, setPctSelected] = useState<number | null>(null);
  const [takeProfitEnabled, setTakeProfitEnabled] = useState(false);
  const [leverage, setLeverage] = useState(3);
  const [amount, setAmount] = useState('');

  const pctOptions = [5, 20, 50];
  const actionPrice = contractSide === 'up' ? UP_PRICE : DOWN_PRICE;
  const amountNum = Number(amount) || 0;
  const shares = actionPrice > 0 ? amountNum / (actionPrice / 100) : 0;
  const exposure = amountNum * leverage;
  const isShort = direction === 'short';
  const accent = isShort ? 'var(--color-bearish-red)' : 'var(--color-bullish-green)';
  const submitLabel = `${direction.toUpperCase()} ${contractSide.toUpperCase()}`;

  const selectPct = (pct: number) => {
    setPctSelected(pct);
    setAmount(((BALANCE * pct) / 100).toFixed(2));
  };

  return (
    <div className="flex h-full min-w-0 flex-col bg-surface-primary text-[11px]">
      <div className="grid grid-cols-2 border-b border-border-subtle px-3">
        {(['long', 'short'] as const).map((side) => {
          const active = direction === side;
          return (
            <button
              key={side}
              onClick={() => setDirection(side)}
              className="relative h-9 text-left text-[12px] font-semibold capitalize transition-colors"
              style={{
                color: active
                  ? side === 'short'
                    ? 'var(--color-bearish-red)'
                    : 'var(--color-bullish-green)'
                  : 'var(--color-text-quaternary)',
              }}
            >
              {side}
              {active && (
                <span
                  className="absolute bottom-0 left-0 h-[2px] w-12 rounded-full"
                  style={{ backgroundColor: accent }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-3 py-3 no-scrollbar">
        <div className="grid grid-cols-2 overflow-hidden rounded-[6px] bg-surface-card">
          {(['up', 'down'] as const).map((side) => {
            const active = contractSide === side;
            const cents = side === 'up' ? UP_PRICE : DOWN_PRICE;
            return (
              <button
                key={side}
                onClick={() => setContractSide(side)}
                className="flex h-11 items-center justify-between px-3 text-[12px] font-semibold uppercase transition-colors"
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
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  {cents.toFixed(1)}¢
                </span>
              </button>
            );
          })}
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-[10px] text-text-tertiary">
            <span>Stake</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              ${amountNum.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={pctSelected ?? 0}
            onChange={(e) => selectPct(Number(e.target.value))}
            className="w-full accent-white"
          />
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {pctOptions.map((pct) => (
            <button
              key={pct}
              onClick={() => selectPct(pct)}
              className={`h-8 rounded-[6px] border text-[11px] transition-colors ${
                pctSelected === pct
                  ? 'border-brand-violet bg-brand-violet text-white font-semibold'
                  : 'border-border-subtle bg-surface-card text-text-quaternary hover:text-text-secondary'
              }`}
            >
              ${pct}
            </button>
          ))}
          <button
            onClick={() => selectPct(100)}
            className={`h-8 rounded-[6px] border text-[11px] transition-colors ${
              pctSelected === 100
                ? 'border-brand-violet bg-brand-violet text-white font-semibold'
                : 'border-border-subtle bg-surface-card text-text-quaternary hover:text-text-secondary'
            }`}
          >
            Max
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <div className="mb-1.5 text-[9px] uppercase tracking-widest text-text-tertiary">
              Amount
            </div>
            <div className="flex h-11 items-center gap-2 rounded-[6px] bg-surface-card px-3">
              <span className="text-[13px] text-text-tertiary">$</span>
              <input
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setPctSelected(null);
                }}
                inputMode="decimal"
                placeholder="0"
                className="min-w-0 flex-1 bg-transparent text-[15px] text-text-primary outline-none placeholder:text-text-tertiary"
                style={{ fontFamily: 'var(--font-mono)' }}
              />
            </div>
          </label>
          <div>
            <div className="mb-1.5 text-[9px] uppercase tracking-widest text-text-tertiary">
              Contracts
            </div>
            <div
              className="flex h-11 items-center rounded-[6px] bg-surface-card px-3 text-[15px] text-text-primary"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              {shares > 0 ? shares.toFixed(2) : '0'}
            </div>
          </div>
        </div>

        <LeverageSlider
          value={leverage}
          onChange={setLeverage}
          tone={isShort ? 'red' : 'green'}
        />

        <div className="grid grid-cols-3 gap-1.5">
          <Metric label="Exposure" value={`$${exposure.toFixed(2)}`} />
          <Metric label="Liq." value={isShort ? '112.4¢' : '2.8¢'} />
          <Metric label="Fee" value="0.18%" />
        </div>

        <button
          onClick={() => setTakeProfitEnabled((v) => !v)}
          className="flex h-9 items-center gap-2 rounded-[6px] text-left text-[11px] text-text-secondary"
        >
          <span
            className={`grid h-5 w-5 place-items-center rounded-[5px] border ${
              takeProfitEnabled
                ? 'border-brand-violet bg-brand-violet text-white'
                : 'border-border-default bg-surface-primary'
            }`}
          >
            {takeProfitEnabled ? <IconCheck size={13} stroke={2.5} /> : null}
          </span>
          TP / SL
        </button>
      </div>

      <div className="shrink-0 px-3 pb-3">
        <button
          className="h-11 w-full rounded-[8px] text-[12px] font-bold uppercase tracking-widest text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            backgroundColor:
              amountNum <= 0 ? 'var(--color-surface-hover)' : accent,
          }}
          disabled={amountNum <= 0}
        >
          {submitLabel}
          <span className="mx-1.5 text-text-tertiary">-</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>
            {amountNum > 0 ? `$${amountNum.toFixed(2)}` : '0'}
          </span>
        </button>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[6px] bg-surface-card px-2 py-1.5">
      <div className="text-[8px] uppercase tracking-widest text-text-quaternary">
        {label}
      </div>
      <div
        className="mt-0.5 text-[10px] font-semibold text-text-secondary"
        style={{ fontFamily: 'var(--font-mono)' }}
      >
        {value}
      </div>
    </div>
  );
}
