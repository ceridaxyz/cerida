import { lazy, Suspense, useState, useRef, useEffect } from 'react';
import ReactGridLayout, {
  type Layout,
  type LayoutItem,
} from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import { IconX, IconPlus } from '@tabler/icons-react';
import Sidebar from '../../components/sidebar';
import TopNav from '../../components/market/top-nav';

export const meta = () => [{ title: 'Trade — Cerida' }];

// ── Viewport-aware grid sizing ─────────────────────────────────────────────────
// TOTAL_ROWS rows always fill the full viewport height.

const COLS = 24;
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

// ── Lazy widgets ───────────────────────────────────────────────────────────────

const OrderBook = lazy(() => import('../../components/market/order-book'));
const BottomTabs = lazy(() => import('../../components/market/bottom-tabs'));
const TradingPanel = lazy(
  () => import('../../components/market/trading-panel'),
);
const RangeTrading = lazy(
  () => import('../../components/trading/range-trading'),
);

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
      <div
        key={i}
        className="skeleton h-4 rounded-badge"
        style={{ opacity: 1 - i * 0.09 }}
      />
    ))}
  </div>
);

const BottomTabsSkeleton = () => (
  <div className="flex flex-col h-full p-3 gap-3">
    <div className="flex gap-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="skeleton h-6 w-16 rounded-[6px]" />
      ))}
    </div>
    <div className="skeleton flex-1 rounded-[8px]" />
  </div>
);

// ── Widget catalog ───────────────────────────────────────────────────────────
// Every available widget type, its default footprint, and its content.

type WidgetType = 'chart' | 'book' | 'trade' | 'range' | 'positions' | 'panel';

interface WidgetSpec {
  label: string;
  w: number;
  h: number;
  minW: number;
  minH: number;
  tabbed?: boolean;
  render: () => React.ReactNode;
}

const CATALOG: Record<WidgetType, WidgetSpec> = {
  chart: {
    label: 'Chart',
    w: 9,
    h: 8,
    minW: 4,
    minH: 3,
    render: () => null,
  },
  book: {
    label: 'Order Book',
    w: 6,
    h: 8,
    minW: 3,
    minH: 3,
    render: () => (
      <Suspense fallback={<OrderBookSkeleton />}>
        <OrderBook />
      </Suspense>
    ),
  },
  trade: {
    label: 'Trade',
    w: 8,
    h: 7,
    minW: 4,
    minH: 5,
    render: () => (
      <Suspense fallback={<TradeSkeleton />}>
        <TradingPanel />
      </Suspense>
    ),
  },
  range: {
    label: 'Range',
    w: 5,
    h: 6,
    minW: 4,
    minH: 5,
    render: () => (
      <Suspense fallback={<TradeSkeleton />}>
        <RangeTrading />
      </Suspense>
    ),
  },
  positions: {
    label: 'Positions',
    w: 15,
    h: 4,
    minW: 4,
    minH: 2,
    render: () => (
      <Suspense fallback={<BottomTabsSkeleton />}>
        <BottomTabs />
      </Suspense>
    ),
  },
  panel: {
    label: 'Panel',
    w: 4,
    h: 6,
    minW: 2,
    minH: 3,
    tabbed: false,
    render: () => null,
  },
};

const ADD_OPTIONS = (Object.keys(CATALOG) as WidgetType[]).map((type) => ({
  type,
  label: CATALOG[type].label,
}));

// ── Layout helpers — first-fit placement for new widgets ───────────────────────

function overlaps(
  a: { x: number; y: number; w: number; h: number },
  b: LayoutItem,
) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

// Scan top-to-bottom, left-to-right for the first free w×h slot.
function findFirstFit(layout: Layout, w: number, h: number, cols: number) {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const candidate = { x, y, w, h };
      if (!layout.some((l) => overlaps(candidate, l))) return { x, y };
    }
  }
}

// ── Widget shell ───────────────────────────────────────────────────────────────

const CloseIcon = () => <IconX size={10} stroke={2.5} />;
const PlusIcon = () => <IconPlus size={12} stroke={2.5} />;

function Widget({
  title,
  children,
  tabbed = true,
  onClose,
}: {
  title: string;
  children?: React.ReactNode;
  tabbed?: boolean;
  onClose?: () => void;
}) {
  const [tabs, setTabs] = useState<string[]>([title]);
  const [active, setActive] = useState(0);

  const addTab = () => {
    setTabs((t) => [...t, `${title} ${t.length + 1}`]);
    setActive(tabs.length);
  };

  const closeTab = (i: number) => {
    if (tabs.length === 1) return;
    setTabs((t) => t.filter((_, idx) => idx !== i));
    setActive((a) => (a >= i && a > 0 ? a - 1 : a));
  };

  return (
    <div className="panel-widget rounded-[18px] overflow-hidden bg-surface-primary border border-border-subtle h-full flex flex-col">
      <div className="widget-handle flex items-center gap-1 px-2 h-9 shrink-0 border-b border-border-subtle cursor-grab active:cursor-grabbing select-none overflow-hidden">
        {!tabbed ? (
          <span className="px-2 text-[11px] font-medium text-text-quaternary uppercase tracking-widest whitespace-nowrap">
            {title}
          </span>
        ) : (
          <>
            <div className="flex items-center gap-1 min-w-0 overflow-hidden">
              {tabs.map((tab, i) => (
                <button
                  key={i}
                  onClick={() => setActive(i)}
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-[8px] text-[11px] font-medium uppercase tracking-widest transition-colors whitespace-nowrap shrink-0 ${
                    active === i
                      ? 'bg-surface-card text-text-primary'
                      : 'text-text-quaternary hover:text-text-secondary'
                  }`}
                >
                  <span className="truncate max-w-24">{tab}</span>
                  {active === i && tabs.length > 1 && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(i);
                      }}
                      className="text-text-quaternary hover:text-text-primary shrink-0"
                    >
                      <CloseIcon />
                    </span>
                  )}
                </button>
              ))}
            </div>

            <button
              onClick={addTab}
              className="flex items-center justify-center w-6 h-6 rounded-[6px] text-text-quaternary hover:text-text-primary hover:bg-surface-card transition-colors shrink-0"
            >
              <PlusIcon />
            </button>
          </>
        )}

        <div className="flex items-center gap-1 ml-auto shrink-0">
          <div className="hidden sm:flex gap-0.75 items-center opacity-30">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="w-0.75 h-0.75 rounded-full bg-text-tertiary"
              />
            ))}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="flex items-center justify-center w-6 h-6 rounded-[6px] text-text-quaternary hover:text-bearish-red hover:bg-surface-card transition-colors"
              title="Remove widget"
            >
              <IconX size={13} stroke={2} />
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden min-h-0">
        {active === 0 ? (
          children
        ) : (
          <div className="flex items-center justify-center h-full text-[11px] text-text-quaternary uppercase tracking-widest">
            Empty setup
          </div>
        )}
      </div>
    </div>
  );
}

// ── Initial board ──────────────────────────────────────────────────────────────

interface Item {
  id: string;
  type: WidgetType;
}

const INITIAL_ITEMS: Item[] = [
  { id: 'panel-top', type: 'panel' },
  { id: 'panel-bottom', type: 'panel' },
  { id: 'chart', type: 'chart' },
  { id: 'book', type: 'book' },
  { id: 'trade', type: 'trade' },
  { id: 'range', type: 'range' },
  { id: 'positions', type: 'positions' },
];

const INITIAL_LAYOUT: Layout = [
  { i: 'panel-top', x: 0, y: 0, w: 4, h: 6, minW: 2, minH: 3 },
  { i: 'panel-bottom', x: 0, y: 6, w: 4, h: 6, minW: 2, minH: 3 },
  { i: 'chart', x: 4, y: 0, w: 9, h: 8, minW: 4, minH: 3 },
  { i: 'book', x: 13, y: 0, w: 6, h: 8, minW: 3, minH: 3 },
  { i: 'trade', x: 19, y: 0, w: 5, h: 6, minW: 4, minH: 3 },
  { i: 'range', x: 19, y: 5, w: 5, h: 6, minW: 4, minH: 5 },
  { i: 'positions', x: 4, y: 8, w: 15, h: 4, minW: 4, minH: 2 },
];

// ── Page ───────────────────────────────────────────────────────────────────────

const TradePage = () => {
  const [items, setItems] = useState<Item[]>(INITIAL_ITEMS);
  const [layout, setLayout] = useState<Layout>(INITIAL_LAYOUT);
  const { ref, width, rowHeight } = useGridSize();
  const nextId = useRef(0);
  const prevCount = useRef(items.length);

  // When a widget is added, scroll the board so the new (bottom-most) widget is visible.
  useEffect(() => {
    if (items.length > prevCount.current && ref.current) {
      const el = ref.current;
      requestAnimationFrame(() =>
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }),
      );
    }
    prevCount.current = items.length;
  }, [items.length, ref]);

  const addWidget = (type: WidgetType) => {
    const spec = CATALOG[type];
    const id = `${type}-${++nextId.current}`;
    setLayout((prev) => {
      const { x, y } = findFirstFit(prev, spec.w, spec.h, COLS);
      return [
        ...prev,
        { i: id, x, y, w: spec.w, h: spec.h, minW: spec.minW, minH: spec.minH },
      ];
    });
    setItems((prev) => [...prev, { id, type }]);
  };

  const removeWidget = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setLayout((prev) => prev.filter((l) => l.i !== id));
  };

  return (
    <div className="flex h-screen overflow-hidden bg-page">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-2 pt-2 shrink-0 relative z-30">
          <TopNav
            addOptions={ADD_OPTIONS}
            onAddWidget={(t) => addWidget(t as WidgetType)}
          />
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
            {items.map((item) => {
              const spec = CATALOG[item.type];
              return (
                <div key={item.id} className="h-full">
                  <Widget
                    title={spec.label}
                    tabbed={spec.tabbed ?? true}
                    onClose={() => removeWidget(item.id)}
                  >
                    {spec.render()}
                  </Widget>
                </div>
              );
            })}
          </ReactGridLayout>
        </div>
      </div>
    </div>
  );
};

export default TradePage;
