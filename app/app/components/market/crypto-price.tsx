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
import { getActiveLadder, getHistory, type HistPoint } from '../../lib/cerida-api';

const POLL_MS = 4000;
const UP = '#19e6bd';
const DOWN = '#f23546';

function formatMins(m: number) {
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remaining = m % 60;
    return remaining > 0 ? `${h}h ${remaining}m` : `${h}h`;
  }
  return `${m}m`;
}

// Underlying spot as an area chart with the baseline strike drawn as a target
// line — "does spot reach the target by expiry?".
export default function CryptoPrice() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const targetLineRef = useRef<IPriceLine | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const [oid, setOid] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<number>(0);
  const [hdr, setHdr] = useState<{ spot: number; target: number; chg: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState<string | null>(null);
  
  const [priceScaleWidth, setPriceScaleWidth] = useState<number>(60);
  const [pillY, setPillY] = useState<number | null>(null);
  const [asset, setAsset] = useState<string>('BTC');

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
        vertLines: { color: 'rgba(255,255,255,0.035)', style: LineStyle.Dashed },
        horzLines: { color: 'rgba(255,255,255,0.05)', style: LineStyle.Dashed },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,255,255,0.15)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#1a1b2e' },
        horzLine: { color: 'rgba(255,255,255,0.15)', width: 1, style: LineStyle.Dashed, labelBackgroundColor: '#1a1b2e' },
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
      lastValueVisible: false,
      priceLineVisible: false,
    });

    chart.subscribeCrosshairMove((param) => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;

      if (
        !param.point ||
        !param.time ||
        param.point.x < 0 ||
        param.point.x > wrapRef.current!.clientWidth ||
        param.point.y < 0 ||
        param.point.y > wrapRef.current!.clientHeight
      ) {
        tooltip.style.display = 'none';
      } else {
        const data = param.seriesData.get(series);
        if (data) {
          tooltip.style.display = 'block';
          tooltip.style.left = `${param.point.x + 12}px`;
          tooltip.style.top = `${param.point.y}px`;
          
          const val = (data as { value?: number; close?: number }).value ?? (data as { value?: number; close?: number }).close ?? 0;
          tooltip.innerHTML = `<span style="color: #ff9800; margin-right: 4px;">•</span><span style="color: #9ca3af;">${asset}</span> <span style="font-weight: bold; color: #ffffff;">$${val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
        } else {
          tooltip.style.display = 'none';
        }
      }
    });

    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      targetLineRef.current = null;
    };
  }, [asset]);

  useEffect(() => {
    let alive = true;
    getActiveLadder()
      .then((l) => {
        const m = l[0];
        if (!alive || !m) return;
        setOid(m.oracleId);
        setExpiry(m.expiry);
        setAsset(m.asset.split('-')[0] || 'BTC');
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
      getHistory(oid)
        .then((pts: HistPoint[]) => {
          if (!alive || pts.length < 2 || !seriesRef.current) return;
          // unique ascending times (1s resolution)
          const byT = new Map<number, number>();
          for (const p of pts) byT.set(Math.floor(p.t / 1000), p.spot);
          const data = [...byT.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({ time: t as UTCTimestamp, value: v }));
          seriesRef.current.setData(data);

          const last = data[data.length - 1]!.value;
          const first = data[0]!.value;
          const tgt = first; // target is always the baseline starting spot

          // colour the area by whether spot is above/below the target
          const above = last >= tgt;
          seriesRef.current.applyOptions({
            lineColor: above ? UP : DOWN,
            topColor: above ? 'rgba(25,230,189,0.18)' : 'rgba(242,53,70,0.18)',
            bottomColor: above ? 'rgba(25,230,189,0)' : 'rgba(242,53,70,0)',
          });

          // (re)draw the target line
          if (targetLineRef.current) seriesRef.current.removePriceLine(targetLineRef.current);
          const minsVal = Math.max(0, Math.round((expiry - Date.now()) / 60000));
          targetLineRef.current = seriesRef.current.createPriceLine({
            price: tgt,
            color: '#f0a020', // original color
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: formatMins(minsVal),
          });

          setHdr({ spot: last, target: tgt, chg: ((last - tgt) / tgt) * 100 });
          setNow(Date.now());
        })
        .catch((e) => alive && setErr(String(e)));
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [oid, expiry]);

  // Coordinate tracking for custom Y-axis pill
  useEffect(() => {
    if (!chartRef.current || !seriesRef.current || !hdr) return;
    const handle = requestAnimationFrame(() => {
      if (!seriesRef.current) return;
      const y = seriesRef.current.priceToCoordinate(hdr.spot);
      setPillY(y);
      setPriceScaleWidth(seriesRef.current.priceScale().width());
    });
    return () => cancelAnimationFrame(handle);
  }, [hdr, now]);

  const mono = { fontFamily: 'var(--font-mono)' } as const;
  const mins = expiry ? Math.max(0, Math.round((expiry - now) / 60000)) : 0;

  return (
    <div className="flex flex-col h-full relative">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle shrink-0">
        <span className="text-[20px] font-bold text-text-primary tracking-tight" style={mono}>
          {hdr ? `$${hdr.spot.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : err ? 'error' : '—'}
        </span>
        {hdr && hdr.target > 0 && (
          <span className="text-text-quaternary text-[11px] font-medium">
            Target <span className="text-text-secondary font-bold" style={mono}>${hdr.target.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          </span>
        )}
        {hdr && (
          <span className="text-[11px] font-semibold" style={{ ...mono, color: hdr.chg >= 0 ? UP : DOWN }}>
            {hdr.chg >= 0 ? '+' : ''}{hdr.chg.toFixed(2)}%
          </span>
        )}
        <span className="ml-auto text-text-quaternary text-[10px]" style={mono}>{mins}m · live</span>
      </div>
      
      <div className="flex-1 min-h-0 relative">
        <div ref={wrapRef} className="w-full h-full" />
        
        {/* Custom Price Pill on the Right Price Scale */}
        <div
          className="absolute pointer-events-none select-none z-20 flex flex-col items-center"
          style={{
            top: pillY !== null ? `${pillY}px` : '0px',
            right: 0,
            width: `${priceScaleWidth}px`,
            transform: 'translateY(-50%)',
            display: pillY !== null ? 'flex' : 'none',
          }}
        >
          <div className="bg-[#ff9800] text-white text-[10px] px-1 py-0.5 rounded-[4px] font-bold" style={mono}>
            ${hdr ? hdr.spot.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : ''}
          </div>
          <div className="flex flex-col items-center -mt-0.5 gap-0.5">
            {hdr && hdr.target > 0 && (
              hdr.spot >= hdr.target ? (
                <>
                  <span className="text-[#f23546] text-[8px] leading-[4px] font-bold">▼</span>
                  <span className="text-[#f23546]/80 text-[8px] leading-[4px] font-bold">▼</span>
                  <span className="text-[#f23546]/50 text-[8px] leading-[4px] font-bold">▼</span>
                </>
              ) : (
                <>
                  <span className="text-[#19e6bd]/50 text-[8px] leading-[4px] font-bold">▲</span>
                  <span className="text-[#19e6bd]/80 text-[8px] leading-[4px] font-bold">▲</span>
                  <span className="text-[#19e6bd] text-[8px] leading-[4px] font-bold">▲</span>
                </>
              )
            )}
          </div>
        </div>

        {/* Custom Hover Tooltip */}
        <div
          ref={tooltipRef}
          className="absolute hidden pointer-events-none select-none z-30 bg-[#0d0f1a]/95 border border-border-subtle rounded-[6px] px-2 py-1 text-[11px] text-text-primary whitespace-nowrap shadow-lg"
          style={{
            transform: 'translateY(-50%)',
            fontFamily: 'var(--font-mono)',
          }}
        />
      </div>
    </div>
  );
}
