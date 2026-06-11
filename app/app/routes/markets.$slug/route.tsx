import { lazy, Suspense, useState, useRef, useEffect } from 'react';
import ReactGridLayout, { type Layout } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import Sidebar from '../../components/sidebar';

export const meta = () => [{ title: 'Trade — Cerida' }];

// ── Viewport-aware grid sizing ─────────────────────────────────────────────────
// TOTAL_ROWS rows always fill the full viewport height.

const COLS       = 12;
const TOTAL_ROWS = 12;
const GAP        = 8;
const PAD        = 8;

function useGridSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1200, rowHeight: 60 });

  useEffect(() => {
    if (!ref.current) return;
    const update = (w: number, h: number) => {
      const rowHeight = Math.floor((h - PAD * 2 - GAP * (TOTAL_ROWS - 1)) / TOTAL_ROWS);
      setSize({ width: w, rowHeight: Math.max(rowHeight, 20) });
    };
    const ro = new ResizeObserver(([e]) => {
      if (e) update(e.contentRect.width, e.contentRect.height);
    });
    ro.observe(ref.current);
    update(ref.current.clientWidth, ref.current.clientHeight);
    return () => ro.disconnect();
  }, []);

  return { ref, ...size };
}

// ── Lazy widgets ───────────────────────────────────────────────────────────────

const OrderBook     = lazy(() => import('../../components/market/order-book'));
const BottomTabs    = lazy(() => import('../../components/market/bottom-tabs'));
const BinaryTrading = lazy(() => import('../../components/trading/binary-trading'));
const RangeTrading  = lazy(() => import('../../components/trading/range-trading'));
const TradingPanel  = lazy(() => import('../../components/market/trading-panel'));

// ── Skeletons ──────────────────────────────────────────────────────────────────

const TradeSkeleton = () => (
  <div className="flex flex-col h-full p-3 gap-3">
    <div className="skeleton h-8 rounded-[8px]" />
    <div className="skeleton h-5 w-2/3 rounded-[6px]" />
    <div className="skeleton h-9 rounded-[8px]" />
    <div className="mt-auto skeleton h-9 rounded-[8px]" />
  </div>
);

const OrderBookSkeleton = () => (
  <div className="flex flex-col h-full p-3 gap-2">
    <div className="skeleton h-5 w-1/3 rounded-[6px]" />
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="skeleton h-4 rounded-badge" style={{ opacity: 1 - i * 0.09 }} />
    ))}
  </div>
);

const BottomTabsSkeleton = () => (
  <div className="flex flex-col h-full p-3 gap-3">
    <div className="flex gap-2">
      {[1, 2, 3].map(i => <div key={i} className="skeleton h-6 w-16 rounded-[6px]" />)}
    </div>
    <div className="skeleton flex-1 rounded-[8px]" />
  </div>
);

// ── Widget shell ───────────────────────────────────────────────────────────────

function Widget({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="panel-widget rounded-[18px] overflow-hidden bg-surface-primary border border-border-subtle h-full flex flex-col">
      <div className="widget-handle flex items-center justify-between px-3 h-9 shrink-0 border-b border-border-subtle cursor-grab active:cursor-grabbing select-none">
        <span className="text-[11px] font-medium text-text-quaternary uppercase tracking-widest">{title}</span>
        <div className="flex gap-0.75 items-center opacity-30">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="w-0.75 h-0.75 rounded-full bg-text-tertiary" />
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-hidden min-h-0">
        {children}
      </div>
    </div>
  );
}

// ── Initial layout — 12×12 grid, fills viewport ────────────────────────────────

const INITIAL_LAYOUT: Layout = [
  { i: 'chart',     x: 0, y: 0,  w: 6, h: 8,  minW: 2, minH: 3 },
  { i: 'book',      x: 6, y: 0,  w: 3, h: 6,  minW: 2, minH: 3 },
  { i: 'binary',    x: 9, y: 0,  w: 3, h: 6,  minW: 2, minH: 4 },
  { i: 'positions', x: 0, y: 8,  w: 6, h: 4,  minW: 2, minH: 2 },
  { i: 'legacy',    x: 6, y: 6,  w: 3, h: 6,  minW: 2, minH: 4 },
  { i: 'range',     x: 9, y: 6,  w: 3, h: 6,  minW: 2, minH: 4 },
];

// ── Page ───────────────────────────────────────────────────────────────────────

const TradePage = () => {
  const [layout, setLayout] = useState<Layout>(INITIAL_LAYOUT);
  const { ref, width, rowHeight } = useGridSize();

  return (
    <div className="flex h-screen overflow-hidden bg-[#08090a]">
      <Sidebar />
      <div ref={ref} className="flex-1 overflow-auto">
        <ReactGridLayout
          layout={layout}
          onLayoutChange={(l: Layout) => setLayout([...l])}
          cols={COLS}
          rowHeight={rowHeight}
          width={width}
          margin={[GAP, GAP]}
          containerPadding={[PAD, PAD]}
          draggableHandle=".widget-handle"
          draggableCancel="input,button,select,textarea,a"
          resizeHandles={['se']}
          compactType="vertical"
          preventCollision={false}
          allowOverlap={false}
          useCSSTransforms
        >
          <div key="chart"     className="h-full"><Widget title="Chart" /></div>
          <div key="book"      className="h-full"><Widget title="Order Book"><Suspense fallback={<OrderBookSkeleton />}><OrderBook /></Suspense></Widget></div>
          <div key="binary"    className="h-full"><Widget title="Continuous Trade"><Suspense fallback={<TradeSkeleton />}><BinaryTrading /></Suspense></Widget></div>
          <div key="positions" className="h-full"><Widget title="Positions"><Suspense fallback={<BottomTabsSkeleton />}><BottomTabs /></Suspense></Widget></div>
          <div key="legacy"    className="h-full"><Widget title="Trade"><Suspense fallback={<TradeSkeleton />}><TradingPanel /></Suspense></Widget></div>
          <div key="range"     className="h-full"><Widget title="Range Trade"><Suspense fallback={<TradeSkeleton />}><RangeTrading /></Suspense></Widget></div>
        </ReactGridLayout>
      </div>
    </div>
  );
};

export default TradePage;
