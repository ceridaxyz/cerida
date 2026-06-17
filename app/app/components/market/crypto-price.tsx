import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  AreaSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from 'lightweight-charts';
import { getChartOracle, getPriceHistory, type PricePoint } from '../../lib/predict-api';

const POLL_MS = 4000;
const UP = '#19e6bd';
const DOWN = '#f23546';

// Underlying BTC spot as an area chart with the binary strike drawn as a target
// line — "does spot reach the target by expiry?".
export default function CryptoPrice() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const targetLineRef = useRef<IPriceLine | null>(null);
  const [oid, setOid] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<number>(0);
  const [target, setTarget] = useState<number>(0);
  const [hdr, setHdr] = useState<{ spot: number; chg: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState<string | null>(null);

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
    const series = chart.addSeries(AreaSeries, {
      lineColor: DOWN,
      topColor: 'rgba(242,53,70,0.18)',
      bottomColor: 'rgba(242,53,70,0)',
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      targetLineRef.current = null;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    getChartOracle()
      .then((o) => {
        if (!alive || !o) return;
        setOid(o.oracle_id);
        setExpiry(o.expiry);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!oid) return;
    let alive = true;
    const tick = () =>
      getPriceHistory(oid)
        .then((pts: PricePoint[]) => {
          if (!alive || pts.length < 2 || !seriesRef.current) return;
          // unique ascending times (1s resolution)
          const byT = new Map<number, number>();
          for (const p of pts) byT.set(Math.floor(p.t / 1000), p.spot);
          const data = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v }));
          seriesRef.current.setData(data);

          const last = data[data.length - 1]!.value;
          const first = data[0]!.value;
          const tgt = target || Math.round(last / 25) * 25 + 25; // strike just above spot
          if (!target) setTarget(tgt);

          // colour the area by whether spot is above/below the target
          const above = last >= tgt;
          seriesRef.current.applyOptions({
            lineColor: above ? UP : DOWN,
            topColor: above ? 'rgba(25,230,189,0.18)' : 'rgba(242,53,70,0.18)',
            bottomColor: above ? 'rgba(25,230,189,0)' : 'rgba(242,53,70,0)',
          });

          // (re)draw the target line
          if (targetLineRef.current) seriesRef.current.removePriceLine(targetLineRef.current);
          const mins = Math.max(0, Math.round((expiry - Date.now()) / 60000));
          targetLineRef.current = seriesRef.current.createPriceLine({
            price: tgt,
            color: '#f0a020',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `${mins}m`,
          });

          setHdr({ spot: last, chg: ((last - first) / first) * 100 });
          setNow(Date.now());
        })
        .catch((e) => alive && setErr(String(e)));
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [oid, target, expiry]);

  const mono = { fontFamily: 'var(--font-mono)' } as const;
  const mins = expiry ? Math.max(0, Math.round((expiry - now) / 60000)) : 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border-subtle shrink-0 text-[11px]">
        <span className="text-[15px] font-bold text-text-primary" style={mono}>
          {hdr ? `$${hdr.spot.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : err ? 'error' : '—'}
        </span>
        {target > 0 && (
          <span className="text-text-quaternary">
            Target <span className="text-text-secondary" style={mono}>${target.toLocaleString('en-US')}</span>
          </span>
        )}
        {hdr && (
          <span className="text-[11px] font-semibold" style={{ ...mono, color: hdr.chg >= 0 ? UP : DOWN }}>
            {hdr.chg >= 0 ? '+' : ''}{hdr.chg.toFixed(2)}%
          </span>
        )}
        <span className="ml-auto text-text-quaternary text-[10px]" style={mono}>{mins}m · live</span>
      </div>
      <div ref={wrapRef} className="flex-1 min-h-0" />
    </div>
  );
}
