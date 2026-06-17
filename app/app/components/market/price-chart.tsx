import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  getChartOracle,
  getPriceHistory,
  getLatestSvi,
  type Svi,
  type PricePoint,
} from '../../lib/predict-api';
import { yesNo } from '../../lib/svi';

const POLL_MS = 4000;
const TARGET_CANDLES = 48;
const UP = '#19e6bd';
const DOWN = '#f23546';

interface Candle { time: UTCTimestamp; open: number; high: number; low: number; close: number }

// YES price (¢) per spot tick at a fixed strike, bucketed into OHLC candles.
function yesCandles(pts: PricePoint[], svi: Svi, strike: number): Candle[] {
  if (pts.length < 2) return [];
  const span = (pts[pts.length - 1]!.t - pts[0]!.t) / 1000 || 1;
  const bucket = Math.max(2, Math.round(span / TARGET_CANDLES));
  const map = new Map<number, Candle>();
  for (const p of pts) {
    const y = yesNo(svi, p.spot, strike).yes * 100;
    const t = (Math.floor(p.t / 1000 / bucket) * bucket) as UTCTimestamp;
    const c = map.get(t);
    if (!c) map.set(t, { time: t, open: y, high: y, low: y, close: y });
    else {
      c.high = Math.max(c.high, y);
      c.low = Math.min(c.low, y);
      c.close = y;
    }
  }
  return [...map.values()].sort((a, b) => (a.time as number) - (b.time as number));
}

export default function PriceChart() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [oid, setOid] = useState<string | null>(null);
  const [strike, setStrike] = useState<number>(0);
  const [hdr, setHdr] = useState<{ yes: number; chg: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Create the themed chart once.
  useEffect(() => {
    if (!wrapRef.current) return;
    const chart = createChart(wrapRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255,255,255,0.4)',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.035)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(128,125,254,0.5)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#807dfe' },
        horzLine: { color: 'rgba(128,125,254,0.5)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#807dfe' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, secondsVisible: true },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      borderVisible: false,
      priceFormat: { type: 'price', precision: 1, minMove: 0.1 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Pick the live oracle once.
  useEffect(() => {
    let alive = true;
    getChartOracle()
      .then((o) => alive && o && setOid(o.oracle_id))
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  // Poll spot history + SVI, derive the YES candles, push to the series.
  useEffect(() => {
    if (!oid) return;
    let alive = true;
    const tick = () =>
      Promise.all([getPriceHistory(oid), getLatestSvi(oid)])
        .then(([pts, svi]) => {
          if (!alive || pts.length < 2 || !seriesRef.current) return;
          // Fix the strike on first load (nearest $25 to current spot) so the
          // YES series is a consistent "price of this contract over time".
          const lastSpot = pts[pts.length - 1]!.spot;
          const k = strike || Math.round(lastSpot / 25) * 25;
          if (!strike) setStrike(k);
          const candles = yesCandles(pts, svi, k);
          seriesRef.current.setData(candles);
          const first = candles[0]!;
          const last = candles[candles.length - 1]!;
          setHdr({ yes: last.close, chg: last.close - first.open });
        })
        .catch((e) => alive && setErr(String(e)));
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [oid, strike]);

  const mono = { fontFamily: 'var(--font-mono)' } as const;
  const yes = hdr?.yes ?? null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle shrink-0 text-[11px]">
        <span className="text-text-secondary font-semibold">YES</span>
        {yes != null ? (
          <>
            <span className="font-bold" style={{ ...mono, color: UP }}>{yes.toFixed(1)}¢</span>
            <span className="text-text-quaternary" style={mono}>NO {(100 - yes).toFixed(1)}¢</span>
            <span className="text-[10px]" style={{ ...mono, color: (hdr?.chg ?? 0) >= 0 ? UP : DOWN }}>
              {(hdr?.chg ?? 0) >= 0 ? '+' : ''}{(hdr?.chg ?? 0).toFixed(1)}¢
            </span>
          </>
        ) : (
          <span className="text-text-quaternary">{err ? `error · ${err}` : 'loading…'}</span>
        )}
        {strike > 0 && (
          <span className="ml-auto text-text-quaternary text-[10px]" style={mono}>
            ≥ ${strike.toLocaleString('en-US')} · live
          </span>
        )}
      </div>

      <div ref={wrapRef} className="flex-1 min-h-0" />
    </div>
  );
}
