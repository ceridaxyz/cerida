import { useState, useRef, useEffect, useCallback } from 'react';
import {
  motion,
  AnimatePresence,
  useMotionValue,
  animate,
} from 'framer-motion';
import { IconChevronDown, IconPlus } from '@tabler/icons-react';
import { useCurrentAccount, useSuiClientQuery, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { useQuery } from '@tanstack/react-query';
import OnboardingModal from '../onboarding-modal';
import { useComboDispatch } from './combo-context';
import { useLevels } from './levels-context';
import { toast } from '../toast/toast-context';
import { getSurface, getActiveLadder } from '../../lib/cerida-api';
import { CERIDA_PKG, VAULT_ID, toChainPrice, toChainDusdc } from '../../lib/contracts';

const BASE_EDGE = 0.06;

const MIN_LEV = 1,
  MAX_LEV = 50,
  STEPS = MAX_LEV - MIN_LEV;
const LABEL_MARKS = [1, 3, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
const barH = (step: number) => 5 + (step / STEPS) * 27;

function LeverageSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbX = useMotionValue(0);
  const dragging = useRef(false);
  const [showHandle, setShowHandle] = useState(false);

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

  const majors = LABEL_MARKS.map((mark, i) => ({
    pos: (mark - MIN_LEV) / STEPS,
    h: barH(mark - MIN_LEV),
    active: mark <= value,
    step: i,
  }));

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
        <div style={{ position: 'absolute', inset: '0 0 18px 0' }}>
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
                backgroundColor: active ? '#9998ff' : 'rgba(255,255,255,0.08)',
                pointerEvents: 'none',
                transition: 'background-color 0.1s',
              }}
            />
          ))}

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
                backgroundColor: active ? '#9998ff' : 'rgba(255,255,255,0.8)',
                opacity: active ? 0.7 : 0.8,
                pointerEvents: 'none',
              }}
            />
          ))}

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
                backgroundColor: '#9998ff',
              }}
            />
          </motion.div>

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
                    backgroundColor: 'rgb(201,200,255)',
                    borderRadius: 6,
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 4px)',
                    gridTemplateRows: 'repeat(3, 4px)',
                    gap: 2,
                    placeContent: 'center',
                    boxShadow:
                      'rgba(153,152,255,0.3) 0px 2px 10px, rgba(0,0,0,0.1) 0px 1px 3px',
                  }}
                >
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div
                      key={i}
                      style={{
                        width: 4,
                        height: 4,
                        borderRadius: '50%',
                        backgroundColor: 'rgb(153,152,255)',
                        opacity: 0.7,
                      }}
                    />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

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
                color: lev === value ? '#9998ff' : 'rgba(255,255,255,0.35)',
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

// ── Small price input ──────────────────────────────────────────────────────────

function PriceInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  color?: string
  placeholder: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-text-tertiary">
        {label}
      </span>
      <input
        type="number"
        value={value}
        placeholder={placeholder}
        step="0.1"
        min="0.1"
        max="99.9"
        onChange={e => onChange(e.target.value)}
        className="w-full bg-transparent text-[13px] text-text-primary placeholder:text-text-quaternary outline-none border-b border-border-subtle focus:border-border-default pb-1"
        style={{ fontFamily: 'var(--font-mono)' }}
      />
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

interface TradingPanelProps {
  oracle_id?: string
  asset?: string
  expiry?: bigint
  strike?: bigint
}

const TradingPanel = ({ oracle_id, asset = 'BTC', expiry, strike }: TradingPanelProps = {}) => {
  const account = useCurrentAccount();
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [direction, setDirection] = useState<'buy' | 'sell'>('buy');
  const [orderType, setOrderType] = useState<'market' | 'limit' | 'pro'>('market');
  const [pctSelected, setPctSelected] = useState<number | null>(null);
  const [takeProfitEnabled, setTakeProfitEnabled] = useState(false);
  const [leverage, setLeverage] = useState(1);
  const [amount, setAmount] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [tpInput, setTpInput] = useState('');
  const [slInput, setSlInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { addLeg } = useComboDispatch();
  const levels = useLevels();

  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const isLeverage = leverage > 1;
  const buyLabel = isLeverage ? 'LONG' : 'BUY';
  const sellLabel = isLeverage ? 'SHORT' : 'SELL';
  const actionLabel = direction === 'buy' ? buyLabel : sellLabel;

  // Fetch active ladder to find oracle if not passed in
  const { data: ladder } = useQuery({
    queryKey: ['activeLadder'],
    queryFn: getActiveLadder,
    staleTime: 30_000,
  });
  const effectiveOracleId = oracle_id ?? ladder?.[0]?.oracleId;

  // Live YES/NO prices from surface
  const { data: surface } = useQuery({
    queryKey: ['surface', effectiveOracleId],
    queryFn: () => getSurface(effectiveOracleId!),
    enabled: !!effectiveOracleId,
    refetchInterval: 4_000,
  });

  // Match surface row to the selected strike
  const strikeNum = strike !== undefined ? Number(strike) : undefined;
  const surfaceRow = surface?.length
    ? strikeNum !== undefined
      ? surface.reduce((best, row) =>
          Math.abs(row.strike - strikeNum) < Math.abs(best.strike - strikeNum) ? row : best,
          surface[0]!)
      : surface[0]!
    : null;

  const buyCents  = surfaceRow?.yes ?? null;
  const sellCents = surfaceRow?.no  ?? null;

  // dUSDC balance (6 decimals). Type comes from env; falls back to the localnet default.
  const quoteCoinType =
    ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_QUOTE_COIN_TYPE as string) ||
    '0x89506beb89764ee41b6df5b3a8f5b77266e2e034df13b68e8eab0ff101a79aac::dusdc::DUSDC';

  const { data: coinData } = useSuiClientQuery(
    'getCoins',
    { owner: account?.address ?? '', coinType: quoteCoinType },
    { enabled: !!account },
  );
  const usdcBalance = coinData?.data
    ? coinData.data.reduce((s, c) => s + BigInt(c.balance), 0n)
    : null;
  const balanceDisplay = usdcBalance !== null
    ? `$${(Number(usdcBalance) / 1e6).toFixed(2)}`
    : '—';

  // Clear levels when TP/SL toggled off
  useEffect(() => {
    if (!takeProfitEnabled) {
      levels.setTp(null);
      levels.setSl(null);
      setTpInput('');
      setSlInput('');
    }
  }, [takeProfitEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleTpChange = (v: string) => {
    setTpInput(v);
    const n = parseFloat(v);
    levels.setTp(isNaN(n) ? null : +Math.max(0.1, Math.min(99.9, n)).toFixed(1));
  };
  const handleSlChange = (v: string) => {
    setSlInput(v);
    const n = parseFloat(v);
    levels.setSl(isNaN(n) ? null : +Math.max(0.1, Math.min(99.9, n)).toFixed(1));
  };

  const pctOptions = [10, 25, 50, 75];

  const handleSubmit = async () => {
    if (!account) { setOnboardingOpen(true); return; }
    if (!effectiveOracleId) {
      toast.error('No active market', 'Could not find an active oracle.');
      return;
    }
    const amtNum = parseFloat(amount);
    if (!amount || isNaN(amtNum) || amtNum <= 0) {
      toast.warning('Enter an amount', 'Specify how much you want to trade.');
      return;
    }

    setSubmitting(true);
    const id = toast.progress(
      `${actionLabel} order`,
      20,
      `Signing ${direction === 'buy' ? 'YES' : 'NO'} for $${amtNum.toFixed(2)}…`,
    );

    try {
      const { Transaction } = await import('@mysten/sui/transactions');
      const tx = new Transaction();
      tx.setGasBudget(10_000_000);

      // Find the ladder entry matching the selected strike for oracle_id + expiry
      const ladderEntry = ladder?.find(m => !strikeNum || Math.abs(m.strike - (strikeNum / 1e9)) < 500)
        ?? ladder?.[0];
      const oracleObjId = ladderEntry?.oracleId ?? effectiveOracleId!;
      const expiryMs = ladderEntry?.expiry ?? (Date.now() + 3600_000);
      const strikeVal = strikeNum ?? (surfaceRow?.strike ? Math.round(surfaceRow.strike * 1e9) : 63_000 * 1e9);
      const isUp = direction === 'buy'; // YES = up (price ≥ strike)
      const escrow = toChainDusdc(amtNum * leverage);
      const qty = BigInt(Math.round(amtNum * leverage * 1e6));

      // TP/SL in bid·qty units (mark value threshold for keeper-triggered early exit)
      const tpVal = takeProfitEnabled && tpInput
        ? BigInt(Math.round((parseFloat(tpInput) / 100) * Number(qty)))
        : 0n;
      const slVal = takeProfitEnabled && slInput
        ? BigInt(Math.round((parseFloat(slInput) / 100) * Number(qty)))
        : 0n;

      if (coinData?.data?.length) {
        const sorted = [...coinData.data].sort((a, b) => Number(BigInt(b.balance) - BigInt(a.balance)));
        const [pay] = tx.splitCoins(tx.object(sorted[0]!.coinObjectId), [tx.pure.u64(escrow)]);
        tx.moveCall({
          target: `${CERIDA_PKG}::vault::request_mint_binary`,
          typeArguments: [quoteCoinType],
          arguments: [
            tx.object(VAULT_ID),
            tx.pure.id(oracleObjId),
            tx.pure.u64(BigInt(expiryMs)),
            tx.pure.u64(BigInt(Math.round(strikeVal))),
            tx.pure.bool(isUp),
            tx.pure.u64(qty),
            tx.pure.u64(0n), // max_cost=0 → market order
            tx.pure.u64(tpVal),
            tx.pure.u64(slVal),
            pay,
          ],
        });
      }

      toast.update(id, { progress: 60, description: 'Broadcasting…' });

      await new Promise<void>((resolve, reject) => {
        signAndExecute(
          { transaction: tx as Parameters<typeof signAndExecute>[0]['transaction'] },
          {
            onSuccess: () => resolve(),
            onError: (e) => reject(e),
          },
        );
      });

      toast.update(id, {
        type: 'success',
        title: `${actionLabel} confirmed`,
        description: `$${amtNum.toFixed(2)} ${direction === 'buy' ? 'YES' : 'NO'} @ ${direction === 'buy' ? buyCents?.toFixed(1) : sellCents?.toFixed(1)}¢`,
        progress: undefined,
        duration: 5000,
      });

      const entryPrice = direction === 'buy' ? buyCents : sellCents;
      if (entryPrice !== null) levels.setEntry(entryPrice);

      setAmount('');
      setPctSelected(null);
    } catch (err) {
      toast.update(id, {
        type: 'error',
        title: 'Order failed',
        description: err instanceof Error ? err.message : String(err),
        progress: undefined,
        duration: null,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col bg-surface-primary h-full min-w-0">
      {/* BUY / SELL → LONG / SHORT when leveraged */}
      <div className="flex border-b border-border-subtle shrink-0">
        <button
          onClick={() => setDirection('buy')}
          className={`flex-1 flex items-center justify-center gap-2 py-2 transition-colors ${
            direction === 'buy'
              ? 'bg-surface-hover text-bullish-green'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          <span className="text-[15px] font-bold tracking-wide">{buyLabel}</span>
          <span className={`text-[13px] font-medium tabular-nums ${direction === 'buy' ? 'text-bullish-green/70' : 'text-text-quaternary'}`}>
            {buyCents !== null ? `${buyCents.toFixed(1)}¢` : '—'}
          </span>
        </button>
        <button
          onClick={() => setDirection('sell')}
          className={`flex-1 flex items-center justify-center gap-2 py-2 transition-colors ${
            direction === 'sell'
              ? 'bg-surface-hover text-bearish-red'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          <span className="text-[15px] font-bold tracking-wide">{sellLabel}</span>
          <span className={`text-[13px] font-medium tabular-nums ${direction === 'sell' ? 'text-bearish-red/70' : 'text-text-quaternary'}`}>
            {sellCents !== null ? `${sellCents.toFixed(1)}¢` : '—'}
          </span>
        </button>
      </div>

      {/* Order type tabs */}
      <div className="flex items-center gap-0 px-3 pt-2 pb-1.5 border-b border-border-subtle shrink-0">
        {(['market', 'limit', 'pro'] as const).map((type) => (
          <button
            key={type}
            onClick={() => setOrderType(type)}
            className={`relative flex items-center gap-1 px-3 py-1.5 text-[14px] font-medium rounded-[5px] transition-colors ${
              orderType === type
                ? 'text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary'
            }`}
          >
            {type.charAt(0).toUpperCase() + type.slice(1)}
            {type === 'limit' && (
              <span className="px-1.5 py-0.5 text-[9px] font-bold text-brand-violet border-[1.5px] border-brand-violet/40 rounded-[6px] uppercase tracking-wider leading-none">
                NEW
              </span>
            )}
            {orderType === type && (
              <span className="absolute bottom-0 left-0 right-0 h-[2px] bg-text-primary rounded-full" />
            )}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 text-[14px] text-text-tertiary cursor-pointer hover:text-text-secondary">
          Pro
          <IconChevronDown size={12} stroke={2.5} />
        </div>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2 flex-1 overflow-hidden">
        {/* Margin / Balance row */}
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-text-secondary">Margin</span>
          <span className="text-[13px] text-text-tertiary">
            Bal.{' '}
            <span className="text-text-secondary" style={{ fontFamily: 'var(--font-mono)' }}>
              {balanceDisplay}
            </span>
          </span>
        </div>

        {/* Amount input */}
        <div className="flex items-center bg-surface-primary rounded-[8px] px-3 py-1.5 border border-border-subtle gap-2">
          <input
            type="number"
            value={amount}
            onChange={e => { setAmount(e.target.value); setPctSelected(null); }}
            placeholder="0.00"
            min="0"
            step="1"
            className="flex-1 min-w-0 bg-transparent text-[20px] font-medium text-text-primary tracking-tight outline-none placeholder:text-text-quaternary"
            style={{ fontFamily: 'var(--font-mono)', letterSpacing: '-0.3px' }}
          />
          <span className="ml-auto flex items-center justify-center px-2.5 py-0.5 rounded-[4px] text-[12px] font-bold bg-surface-card text-text-primary border border-border-subtle leading-none shrink-0">
            {leverage}X
          </span>
        </div>

        {/* Limit price — only when limit tab active */}
        {orderType === 'limit' && (
          <div className="flex items-center bg-surface-primary rounded-[8px] px-3 py-1.5 border border-border-subtle gap-2">
            <span className="text-[11px] text-text-tertiary uppercase tracking-widest shrink-0">
              Limit ¢
            </span>
            <input
              type="number"
              value={limitPrice}
              onChange={e => setLimitPrice(e.target.value)}
              placeholder={
                direction === 'buy'
                  ? (buyCents?.toFixed(1) ?? '50.0')
                  : (sellCents?.toFixed(1) ?? '50.0')
              }
              min="0.1"
              max="99.9"
              step="0.1"
              className="flex-1 min-w-0 bg-transparent text-[14px] font-medium text-text-primary outline-none placeholder:text-text-quaternary text-right"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </div>
        )}

        {/* Percentage buttons */}
        <div className="flex items-center gap-1.5">
          {pctOptions.map((pct) => (
            <button
              key={pct}
              onClick={() => setPctSelected(pct === pctSelected ? null : pct)}
              className={`flex-1 py-1.5 text-[13px] font-medium rounded-[5px] transition-colors ${
                pctSelected === pct
                  ? 'bg-surface-hover text-text-primary'
                  : 'bg-surface-primary text-text-tertiary hover:text-text-secondary hover:bg-surface-hover/60'
              }`}
            >
              {pct}%
            </button>
          ))}
          <button
            onClick={() => setPctSelected(100)}
            className={`flex-1 py-1.5 text-[13px] font-medium rounded-[5px] transition-colors ${
              pctSelected === 100
                ? 'bg-surface-hover text-text-primary'
                : 'bg-surface-primary text-text-tertiary hover:text-text-secondary hover:bg-surface-hover/60'
            }`}
          >
            MAX
          </button>
        </div>

        {/* Leverage slider */}
        <LeverageSlider value={leverage} onChange={setLeverage} />

        {/* Take profit / Stop loss toggle */}
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-text-secondary">
            Take profit / Stop loss
          </span>
          <button
            onClick={() => setTakeProfitEnabled(!takeProfitEnabled)}
            aria-pressed={takeProfitEnabled}
            className={`h-5 w-9 rounded-pill border p-0.5 transition-colors ${
              takeProfitEnabled
                ? 'border-brand-violet bg-brand-violet'
                : 'border-border-default bg-surface-card'
            }`}
          >
            <span
              className={`block h-3.5 w-3.5 rounded-pill transition-transform bg-white ${
                takeProfitEnabled ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* TP/SL price inputs — animated expand */}
        <AnimatePresence>
          {takeProfitEnabled && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              className="overflow-hidden"
            >
              <div className="flex gap-4 pt-1">
                <div className="flex-1">
                  <PriceInput
                    label="Take Profit ¢"
                    value={tpInput}
                    onChange={handleTpChange}
                    placeholder={
                      buyCents !== null ? (buyCents * 1.25).toFixed(1) : '—'
                    }
                  />
                </div>
                <div className="flex-1">
                  <PriceInput
                    label="Stop Loss ¢"
                    value={slInput}
                    onChange={handleSlChange}
                    placeholder={
                      buyCents !== null ? (buyCents * 0.75).toFixed(1) : '—'
                    }
                  />
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Action + Combo */}
      <div className="px-3 pb-3 flex flex-col gap-1.5 shrink-0">
        {account ? (
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className={`w-full py-2.5 text-[13px] font-semibold rounded-[8px] transition-opacity disabled:opacity-50 ${
              direction === 'buy'
                ? 'bg-bullish-green text-[#1a1a1a] hover:opacity-90'
                : 'bg-bearish-red text-white hover:opacity-90'
            }`}
          >
            {submitting ? 'Signing…' : actionLabel}
          </button>
        ) : (
          <button
            onClick={() => setOnboardingOpen(true)}
            className="w-full py-2.5 bg-bullish-green text-[#1a1a1a] text-[13px] font-semibold rounded-[8px] hover:opacity-90 transition-opacity"
          >
            Connect Wallet
          </button>
        )}
        <button
          onClick={() => addLeg({
            id:         `trade-${direction}-${strike ?? 0}`,
            label:      `${direction === 'buy' ? 'YES' : 'NO'} ${asset}/USD`,
            direction:  direction === 'buy' ? 'yes' : 'no',
            prob:       direction === 'buy'
              ? (buyCents ?? 50) / 100
              : (sellCents ?? 50) / 100,
            multiplier: (1 - BASE_EDGE) /
              ((direction === 'buy' ? (buyCents ?? 50) : (sellCents ?? 50)) / 100),
            oracle_id,
            asset,
            expiry,
            strike,
          })}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[11px] font-semibold rounded-[7px] transition-all bg-surface-card text-text-secondary border border-border-subtle hover:border-brand-violet hover:text-brand-violet hover:bg-brand-violet/5 cursor-pointer"
        >
          <IconPlus size={11} stroke={2.5} />
          Add to Combo
        </button>
      </div>

      <OnboardingModal open={onboardingOpen} onClose={() => setOnboardingOpen(false)} />
    </div>
  );
};

export default TradingPanel;
