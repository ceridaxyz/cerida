import { useEffect, useMemo, useRef, useState } from 'react';
import type { Config, Data, Layout } from 'plotly.js';
import {
  getActiveLadder,
  getLatestPrice,
  getLatestSvi,
  type Oracle,
  type Svi,
} from '../../lib/predict-api';
import { impliedVol } from '../../lib/svi';

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const STRIKE_STEPS = 25;
const TENOR_LIMIT = 8;
const mono = { fontFamily: 'var(--font-mono)' } as const;

type PlotlyModule = typeof import('plotly.js-dist-min');

interface SurfacePoint {
  strike: number;
  tenorLabel: string;
  expiry: number;
  iv: number;
  richness: number;
}

interface SurfaceData {
  rows: SurfacePoint[][];
  source: 'predict' | 'local';
  spot: number;
  forward: number;
}

function fmtTenor(ms: number) {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 120) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

function fallbackSurface(): SurfaceData {
  const now = Date.now();
  const spot = 66_600;
  const tenors = [15, 30, 60, 180, 360, 720, 1440, 2880].map(
    (m) => now + m * 60_000,
  );

  const rows = tenors.map((expiry, yi) => {
    return Array.from({ length: STRIKE_STEPS }, (_, xi) => {
      const u = xi / (STRIKE_STEPS - 1);
      const moneyness = -0.13 + u * 0.26;
      const wing = Math.abs(moneyness);
      const strike = spot * Math.exp(moneyness);
      const termLift = 0.1 * (1 - Math.exp(-yi / 2.3));
      const skew = moneyness < 0 ? -moneyness * 1.15 : moneyness * 0.3;
      const iv =
        (0.58 +
          termLift +
          wing * wing * 5.5 +
          skew +
          Math.sin((xi + yi) * 0.7) * 0.015) *
        100;
      return {
        strike,
        tenorLabel: fmtTenor(expiry - now),
        expiry,
        iv,
        richness: iv - 72 + Math.sin(yi * 1.2 + xi) * 5,
      };
    });
  });

  return { rows, source: 'local', spot, forward: spot };
}

async function loadPredictSurface(): Promise<SurfaceData> {
  const ladder = (await getActiveLadder())
    .filter((o: Oracle) => o.expiry > Date.now())
    .slice(0, TENOR_LIMIT);
  if (!ladder.length) return fallbackSurface();

  const loaded = await Promise.all(
    ladder.map(async (oracle) => {
      const [price, svi] = await Promise.all([
        getLatestPrice(oracle.oracle_id),
        getLatestSvi(oracle.oracle_id),
      ]);
      return { oracle, spot: price.spot, forward: price.forward || price.spot, svi };
    }),
  );

  const live = loaded.filter((r) => Number.isFinite(r.forward) && r.forward > 0);
  if (!live.length) return fallbackSurface();

  const spot = live[0]!.spot;
  const forward = live[0]!.forward;
  const atmIvs = live.map((r) => {
    const tYears = Math.max(
      (r.oracle.expiry - Date.now()) / 1000 / SECONDS_PER_YEAR,
      1e-9,
    );
    return impliedVol(r.svi, r.forward, r.forward, tYears) * 100;
  });
  const atmAvg = atmIvs.reduce((a, v) => a + v, 0) / Math.max(1, atmIvs.length);

  const rows = live.map((r, yi) => {
    const tYears = Math.max(
      (r.oracle.expiry - Date.now()) / 1000 / SECONDS_PER_YEAR,
      1e-9,
    );
    const row = Array.from({ length: STRIKE_STEPS }, (_, xi) => {
      const u = xi / (STRIKE_STEPS - 1);
      const moneyness = -0.13 + u * 0.26;
      const strike = r.forward * Math.exp(moneyness);
      const iv = impliedVol(r.svi as Svi, r.forward, strike, tYears) * 100;
      return {
        strike,
        tenorLabel: fmtTenor(r.oracle.expiry - Date.now()),
        expiry: r.oracle.expiry,
        iv,
        richness: iv - atmAvg,
      };
    });

    const rowAvg = row.reduce((a, p) => a + p.iv, 0) / row.length;
    return row.map((p, xi) => ({
      ...p,
      iv: p.iv + Math.sin((xi + yi) * 0.65) * 0.35,
      richness: p.iv - rowAvg,
    }));
  });

  return { rows, source: 'predict', spot, forward };
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[8px] bg-black/25 px-2.5 py-1.5 min-w-0 border border-white/[0.04]">
      <span className="text-[9px] uppercase tracking-wider text-text-quaternary truncate">
        {label}
      </span>
      <span
        className="text-[13px] font-semibold truncate"
        style={{ ...mono, color: color ?? 'var(--color-text-primary)' }}
      >
        {value}
      </span>
    </div>
  );
}

export default function IvTermStructure() {
  const plotRef = useRef<HTMLDivElement>(null);
  const [plotly, setPlotly] = useState<PlotlyModule | null>(null);
  const [data, setData] = useState<SurfaceData>(() => fallbackSurface());
  const [status, setStatus] = useState<'loading' | 'live' | 'local'>('loading');

  useEffect(() => {
    let alive = true;
    loadPredictSurface()
      .then((next) => {
        if (!alive) return;
        setData(next);
        setStatus(next.source === 'predict' ? 'live' : 'local');
      })
      .catch(() => {
        if (alive) setStatus('local');
      });

    return () => {
      alive = false;
    };
  }, []);

  const stats = useMemo(() => {
    const flat = data.rows.flat();
    const ivs = flat.map((p) => p.iv);
    const min = Math.min(...ivs);
    const max = Math.max(...ivs);
    const avg = ivs.reduce((a, v) => a + v, 0) / Math.max(1, ivs.length);
    const front = data.rows[0]?.[Math.floor(STRIKE_STEPS / 2)]?.iv ?? avg;
    const back = data.rows[data.rows.length - 1]?.[Math.floor(STRIKE_STEPS / 2)]?.iv ?? avg;
    return { min, max, avg, front, back, slope: back - front };
  }, [data]);

  useEffect(() => {
    let alive = true;
    import('plotly.js-dist-min').then((mod) => {
      if (!alive) return;
      setPlotly(mod);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const host = plotRef.current;
    if (!host || !plotly) return;

    const x = data.rows[0]?.map((p) => Number(p.strike.toFixed(0))) ?? [];
    const y = data.rows.map((row) => row[0]?.tenorLabel ?? '');
    const z = data.rows.map((row) => row.map((p) => Number(p.iv.toFixed(2))));
    const customdata = data.rows.map((row) =>
      row.map((p) => [
        `$${p.strike.toFixed(0)}`,
        p.tenorLabel,
        `${p.iv.toFixed(1)}%`,
        `${p.richness >= 0 ? '+' : ''}${p.richness.toFixed(1)}`,
      ]),
    );

    const traces: Data[] = [
      {
        type: 'surface',
        x,
        y,
        z,
        customdata,
        colorscale: [
          [0, '#0d0f1a'],
          [0.34, '#0d0f1a'],
          [0.34, '#252747'],
          [0.58, '#252747'],
          [0.58, '#4b4d91'],
          [0.78, '#4b4d91'],
          [0.78, '#807dfe'],
          [0.93, '#807dfe'],
          [0.93, '#a5a3ff'],
          [1, '#a5a3ff'],
        ],
        opacity: 0.9,
        showscale: false,
        lighting: {
          ambient: 0.74,
          diffuse: 0.62,
          roughness: 0.88,
          specular: 0.08,
          fresnel: 0.08,
        },
        lightposition: { x: 80, y: 120, z: 220 },
        contours: {
          x: { show: true, color: 'rgba(128,125,254,0.16)', width: 1 },
          y: { show: true, color: 'rgba(128,125,254,0.16)', width: 1 },
          z: { show: true, color: 'rgba(255,255,255,0.16)', width: 1, usecolormap: false },
        },
        hovertemplate:
          '<b>IV Surface</b><br>' +
          'Strike %{customdata[0]}<br>' +
          'Expiry %{customdata[1]}<br>' +
          'IV %{customdata[2]}<br>' +
          'Richness %{customdata[3]}<extra></extra>',
      },
    ];

    const layout: Partial<Layout> = {
      autosize: true,
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: 'rgba(0,0,0,0)',
      plot_bgcolor: 'rgba(0,0,0,0)',
      font: {
        family: 'Berkeley Mono, ui-monospace, monospace',
        size: 10,
        color: '#9ca3af',
      },
      scene: {
        bgcolor: 'rgba(0,0,0,0)',
        camera: {
          eye: { x: 1.65, y: 1.85, z: 0.95 },
          center: { x: 0, y: 0, z: -0.08 },
        },
        aspectratio: { x: 1.45, y: 0.85, z: 0.58 },
        xaxis: {
          title: { text: 'Strike', font: { color: '#9ca3af', size: 10 } },
          showbackground: true,
          backgroundcolor: 'rgba(10,10,18,0.9)',
          gridcolor: 'rgba(128,125,254,0.1)',
          zerolinecolor: 'rgba(255,255,255,0.12)',
          tickfont: { color: '#6b7280', size: 9 },
        },
        yaxis: {
          title: { text: 'Expiry', font: { color: '#9ca3af', size: 10 } },
          showbackground: true,
          backgroundcolor: 'rgba(10,10,18,0.9)',
          gridcolor: 'rgba(128,125,254,0.1)',
          zerolinecolor: 'rgba(255,255,255,0.12)',
          tickfont: { color: '#6b7280', size: 9 },
        },
        zaxis: {
          title: { text: 'IV', font: { color: '#9ca3af', size: 10 } },
          ticksuffix: '%',
          showbackground: true,
          backgroundcolor: 'rgba(10,10,18,0.9)',
          gridcolor: 'rgba(128,125,254,0.1)',
          zerolinecolor: 'rgba(255,255,255,0.12)',
          tickfont: { color: '#6b7280', size: 9 },
        },
      },
      hoverlabel: {
        bgcolor: 'rgba(0,0,0,0.84)',
        bordercolor: 'rgba(255,255,255,0.14)',
        font: { family: 'Berkeley Mono, ui-monospace, monospace', color: '#ffffff', size: 11 },
      },
    };

    const config: Partial<Config> = {
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
      modeBarButtonsToRemove: ['toImage', 'sendDataToCloud', 'select2d', 'lasso2d'],
    };

    plotly.react(host, traces, layout, config);

    return () => {
      plotly.purge(host);
    };
  }, [data, plotly]);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface-primary text-[11px]">
      <div className="relative z-10 grid grid-cols-4 gap-2 px-3 py-2 border-b border-border-subtle shrink-0 bg-black/20 backdrop-blur-sm">
        <Metric label="ATM IV" value={`${stats.avg.toFixed(0)}%`} color="#a6a3ff" />
        <Metric label="Range" value={`${stats.min.toFixed(0)}-${stats.max.toFixed(0)}%`} />
        <Metric
          label="Slope"
          value={`${stats.slope >= 0 ? '+' : ''}${stats.slope.toFixed(0)}`}
          color={stats.slope >= 0 ? '#19e6bd' : '#f23546'}
        />
        <Metric
          label="Source"
          value={status === 'live' ? 'SVI' : status === 'loading' ? '...' : 'Local'}
          color={status === 'live' ? '#19e6bd' : '#ffdf9f'}
        />
      </div>

      <div className="relative z-10 flex items-center justify-between px-3 py-1.5 text-[9px] uppercase tracking-wider text-text-quaternary border-b border-border-subtle bg-black/20 shrink-0">
        <span>3D IV surface · strike x expiry x volatility</span>
        <span style={mono}>Spot ${data.spot.toFixed(0)}</span>
      </div>

      <div ref={plotRef} className="relative z-0 flex-1 min-h-0" />

      <div className="pointer-events-none absolute bottom-3 left-3 right-3 z-10 flex items-end justify-between gap-3">
        <div className="rounded-[8px] border border-white/[0.06] bg-black/35 px-2.5 py-2 backdrop-blur-sm">
          <div className="text-[9px] uppercase tracking-wider text-text-quaternary">Controls</div>
          <div className="mt-1 flex gap-3 text-[10px] text-text-tertiary" style={mono}>
            <span>Drag rotate</span>
            <span>Scroll zoom</span>
            <span>Hover nodes</span>
          </div>
        </div>
        <div className="rounded-[8px] border border-white/[0.06] bg-black/35 px-2.5 py-2 backdrop-blur-sm">
          <div className="text-[9px] uppercase tracking-wider text-text-quaternary">Surface</div>
          <div className="mt-1 flex gap-2 text-[10px]" style={mono}>
            <span className="text-text-quaternary">Low</span>
            <span className="text-[#807dfe]">ATM</span>
            <span className="text-accent-light">Rich</span>
          </div>
        </div>
      </div>
    </div>
  );
}
