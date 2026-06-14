import { useState, useRef, useEffect } from 'react';
import ReactGridLayout, { type Layout } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import Sidebar from '../../components/sidebar';
import { useGridState } from '../../components/grid/use-grid-state';
import GridChart from '../../components/grid/grid-chart';
import BandPanel from '../../components/grid/band-panel';
import OrderSummary from '../../components/grid/order-summary';
import PayoffPanel from '../../components/grid/payoff-panel';

export const meta = () => [{ title: 'Grid — Cerida' }];

// ── Viewport-aware grid sizing ─────────────────────────────────────────────────

const COLS = 12;
const TOTAL_ROWS = 12;
const GAP = 6;
const PAD = 6;

function useGridSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1200, rowHeight: 60 });

  useEffect(() => {
    if (!ref.current) return;
    const update = (w: number, h: number) => {
      const rowHeight = Math.floor(
        (h - PAD * 2 - GAP * (TOTAL_ROWS - 1)) / TOTAL_ROWS,
      );
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

// ── Widget shell ───────────────────────────────────────────────────────────────

function Widget({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="panel-widget rounded-[14px] overflow-hidden bg-surface-primary border border-border-subtle h-full flex flex-col">
      <div className="widget-handle flex items-center px-3 h-9 shrink-0 border-b border-border-subtle cursor-grab active:cursor-grabbing select-none">
        <span className="text-[11px] font-medium text-text-quaternary uppercase tracking-widest">
          {title}
        </span>
      </div>
      <div className="flex-1 overflow-hidden min-h-0">
        {children ?? (
          <div className="flex items-center justify-center h-full text-[11px] text-text-quaternary uppercase tracking-widest">
            {title}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Layout ───────────────────────────────────────────────────────────────────
// Left column: big (top) + rectangular (bottom). Right column: two stacked panels.

const INITIAL_LAYOUT: Layout = [
  { i: 'big', x: 0, y: 0, w: 8, h: 8, minW: 3, minH: 4 },
  { i: 'rect', x: 0, y: 8, w: 8, h: 4, minW: 3, minH: 2 },
  { i: 'panel-top', x: 8, y: 0, w: 4, h: 6, minW: 2, minH: 3 },
  { i: 'panel-bottom', x: 8, y: 6, w: 4, h: 6, minW: 2, minH: 3 },
];

const GridPage = () => {
  const [layout, setLayout] = useState<Layout>(INITIAL_LAYOUT);
  const { ref, width, rowHeight } = useGridSize();
  const s = useGridState();

  return (
    <div className="flex h-screen overflow-hidden bg-page">
      <Sidebar />

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center h-13 px-4 shrink-0 border-b border-border-subtle">
          <h1 className="text-[15px] font-semibold text-text-primary">Grid</h1>
        </div>

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
            resizeHandles={['s', 'e', 'se', 'w', 'n', 'sw', 'ne', 'nw']}
            compactType="vertical"
            preventCollision={false}
            allowOverlap={false}
            useCSSTransforms
          >
            <div key="big" className="h-full"><Widget title="Grid"><GridChart s={s} /></Widget></div>
            <div key="rect" className="h-full"><Widget title="Payoff"><PayoffPanel s={s} /></Widget></div>
            <div key="panel-top" className="h-full"><Widget title="Bands"><BandPanel s={s} /></Widget></div>
            <div key="panel-bottom" className="h-full"><Widget title="Order"><OrderSummary s={s} /></Widget></div>
          </ReactGridLayout>
        </div>
      </div>
    </div>
  );
};

export default GridPage;
