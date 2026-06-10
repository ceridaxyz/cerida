import { lazy, Suspense, useState } from 'react';
import ReactGridLayout, { WidthProvider } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import Sidebar from '../../components/sidebar';

const RGL = WidthProvider(ReactGridLayout);

const OrderBook     = lazy(() => import('../../components/market/order-book'));
const BottomTabs    = lazy(() => import('../../components/market/bottom-tabs'));
const BinaryTrading = lazy(() => import('../../components/trading/binary-trading'));
const RangeTrading  = lazy(() => import('../../components/trading/range-trading'));
const TradingPanel  = lazy(() => import('../../components/market/trading-panel'));

export const meta = () => [{ title: 'Trade — Cerida' }];

// ── Skeletons ──────────────────────────────────────────────────────────────────

const TradeSkeleton = () => (
  <div className="flex flex-col h-full p-3 gap-3">
    <div className="skeleton h-8 rounded-[8px]" />
    <div className="skeleton h-5 w-2/3 rounded-[6px]" />
    <div className="skeleton h-9 rounded-[8px]" />
    <div className="skeleton h-9 rounded-[8px]" />
    <div className="mt-auto skeleton h-9 rounded-[8px]" />
  </div>
);

const OrderBookSkeleton = () => (
  <div className="flex flex-col h-full p-3 gap-2">
    <div className="skeleton h-5 w-1/3 rounded-[6px]" />
    {Array.from({ length: 8 }).map((_, i) => (
      <div key={i} className="skeleton h-4 rounded-[4px]" style={{ opacity: 1 - i * 0.09 }} />
    ))}
  </div>
);

const BottomTabsSkeleton = () => (
  <div className="flex flex-col h-full p-3 gap-3">
    <div className="flex gap-2">
      {[1,2,3].map(i => <div key={i} className="skeleton h-6 w-16 rounded-[6px]" />)}
    </div>
    <div className="skeleton flex-1 rounded-[8px]" />
  </div>
);

// ── Widget shell ───────────────────────────────────────────────────────────────

function Widget({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="panel-widget rounded-[18px] overflow-hidden bg-surface-primary border border-border-subtle h-full flex flex-col">
      {/* Drag handle */}
      <div className="widget-handle flex items-center justify-between px-3 h-8 shrink-0 border-b border-border-subtle cursor-grab select-none">
        <span className="text-[11px] font-medium text-text-quaternary uppercase tracking-widest">
          {title}
        </span>
        <div className="flex gap-[3px] items-center opacity-30">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="w-[3px] h-[3px] rounded-full bg-text-tertiary" />
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {children}
      </div>
    </div>
  );
}

// ── Layout ─────────────────────────────────────────────────────────────────────

const INITIAL_LAYOUT = [
  { i: 'chart',    x: 0, y: 0,  w: 5, h: 9,  minW: 3, minH: 5 },
  { i: 'book',     x: 5, y: 0,  w: 2, h: 9,  minW: 2, minH: 4 },
  { i: 'binary',   x: 7, y: 0,  w: 3, h: 11, minW: 2, minH: 6 },
  { i: 'range',    x: 7, y: 11, w: 3, h: 11, minW: 2, minH: 6 },
  { i: 'positions',x: 0, y: 9,  w: 5, h: 6,  minW: 3, minH: 3 },
  { i: 'legacy',   x: 5, y: 9,  w: 2, h: 13, minW: 2, minH: 6 },
];

const TradePage = () => {
  const [layout, setLayout] = useState(INITIAL_LAYOUT);

  return (
    <div className="flex h-screen overflow-hidden bg-[#08090a]">
      <Sidebar />

      <div className="flex-1 overflow-auto">
        <RGL
          layout={layout}
          onLayoutChange={(l) => setLayout([...l])}
          cols={12}
          rowHeight={42}
          margin={[8, 8]}
          containerPadding={[12, 12]}
          draggableHandle=".widget-handle"
          resizeHandles={['se']}
          className="min-h-full"
        >
          <div key="chart">
            <Widget title="Chart" />
          </div>

          <div key="book">
            <Widget title="Order Book">
              <Suspense fallback={<OrderBookSkeleton />}>
                <OrderBook />
              </Suspense>
            </Widget>
          </div>

          <div key="binary">
            <Widget title="Continuous Trade">
              <Suspense fallback={<TradeSkeleton />}>
                <BinaryTrading />
              </Suspense>
            </Widget>
          </div>

          <div key="range">
            <Widget title="Range Trade">
              <Suspense fallback={<TradeSkeleton />}>
                <RangeTrading />
              </Suspense>
            </Widget>
          </div>

          <div key="positions">
            <Widget title="Positions">
              <Suspense fallback={<BottomTabsSkeleton />}>
                <BottomTabs />
              </Suspense>
            </Widget>
          </div>

          <div key="legacy">
            <Widget title="Trade">
              <Suspense fallback={<TradeSkeleton />}>
                <TradingPanel />
              </Suspense>
            </Widget>
          </div>
        </RGL>
      </div>
    </div>
  );
};

export default TradePage;
