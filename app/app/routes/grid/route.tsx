import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import ReactGridLayout, { type Layout } from 'react-grid-layout/legacy';
import 'react-grid-layout/css/styles.css';
import { IconX, IconPlus } from '@tabler/icons-react';
import Sidebar from '../../components/sidebar';
import { useGridState } from '../../components/grid/use-grid-state';
import GridChart from '../../components/grid/grid-chart';
import BandPanel from '../../components/grid/band-panel';
import OrderSummary from '../../components/grid/order-summary';
import PayoffPanel from '../../components/grid/payoff-panel';
import AnalyticsPanel from '../../components/grid/analytics-panel';
import StrikeLandscape from '../../components/grid/strike-landscape';

export const meta = () => [{ title: 'Grid — Cerida' }];

// ── Viewport-aware sizing ─────────────────────────────────────────────────────

const COLS       = 12;
const TOTAL_ROWS = 12;
const GAP        = 6;
const PAD        = 6;

function useGridSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1200, rowHeight: 60 });
  useEffect(() => {
    if (!ref.current) return;
    const update = (w: number, h: number) => {
      const rowHeight = Math.floor((h - PAD * 2 - GAP * (TOTAL_ROWS - 1)) / TOTAL_ROWS);
      setSize({ width: w, rowHeight: Math.max(rowHeight, 20) });
    };
    const ro = new ResizeObserver(([e]) => { if (e) update(e.contentRect.width, e.contentRect.height); });
    ro.observe(ref.current);
    update(ref.current.clientWidth, ref.current.clientHeight);
    return () => ro.disconnect();
  }, []);
  return { ref, ...size };
}

// ── Widget catalog ────────────────────────────────────────────────────────────

type WidgetType = 'chart' | 'bands' | 'order' | 'payoff' | 'analytics' | 'landscape';

interface Spec { label: string; render: (s: ReturnType<typeof useGridState>) => React.ReactNode }

const CATALOG: Record<WidgetType, Spec> = {
  chart:     { label: 'Grid',      render: s => <GridChart s={s} /> },
  bands:     { label: 'Bands',     render: s => <BandPanel s={s} /> },
  order:     { label: 'Order',     render: s => <OrderSummary s={s} /> },
  payoff:    { label: 'Payoff',    render: s => <PayoffPanel s={s} /> },
  analytics: { label: 'Analytics', render: s => <AnalyticsPanel s={s} /> },
  landscape: { label: 'Landscape', render: () => <StrikeLandscape /> },
};

const ADD_OPTIONS = (Object.keys(CATALOG) as WidgetType[]).map(type => ({
  type, label: CATALOG[type].label,
}));

// ── Widget shell — matches trade page exactly ─────────────────────────────────

function Widget({
  tabs, active, options, content, onSelect, onAddTab, onCloseTab, onClose,
}: {
  tabs:      { id: string; label: string }[];
  active:    number;
  options:   { type: string; label: string }[];
  content:   React.ReactNode;
  onSelect:  (i: number) => void;
  onAddTab:  (type: string) => void;
  onCloseTab:(i: number) => void;
  onClose?:  () => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div className="panel-widget rounded-[18px] overflow-hidden bg-surface-primary border border-border-subtle h-full flex flex-col">
      <div className="widget-handle flex items-center gap-1 px-2 h-9 shrink-0 border-b border-border-subtle cursor-grab active:cursor-grabbing select-none">
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto no-scrollbar flex-1">
          {tabs.map((tab, i) => (
            <button
              key={tab.id}
              onClick={() => onSelect(i)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-[8px] text-[11px] font-medium uppercase tracking-widest transition-colors whitespace-nowrap shrink-0 ${
                active === i
                  ? 'bg-surface-card text-text-primary'
                  : 'text-text-quaternary hover:text-text-secondary'
              }`}
            >
              <span className="truncate max-w-28">{tab.label}</span>
              {active === i && tabs.length > 1 && (
                <span
                  onClick={e => { e.stopPropagation(); onCloseTab(i); }}
                  className="text-text-quaternary hover:text-text-primary shrink-0"
                >
                  <IconX size={10} stroke={2.5} />
                </span>
              )}
            </button>
          ))}
          <button
            onClick={e => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
            }}
            className="flex items-center justify-center w-6 h-6 rounded-[6px] text-text-quaternary hover:text-text-primary hover:bg-surface-card transition-colors shrink-0"
          >
            <IconPlus size={12} stroke={2.5} />
          </button>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="flex items-center justify-center w-6 h-6 rounded-[6px] text-text-quaternary hover:text-bearish-red hover:bg-surface-card transition-colors shrink-0 ml-auto"
          >
            <IconX size={13} stroke={2} />
          </button>
        )}
      </div>

      <div className="flex-1 overflow-hidden min-h-0">{content}</div>

      {menu && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setMenu(null)} />
          <div
            className="fixed z-[61] min-w-36 rounded-[10px] border border-border-subtle bg-surface-card shadow-xl py-1"
            style={{ left: menu.x, top: menu.y }}
          >
            <div className="px-3 py-1 text-[9px] uppercase tracking-widest text-text-quaternary">Add tab</div>
            {options.map(o => (
              <button
                key={o.type}
                onClick={() => { onAddTab(o.type); setMenu(null); }}
                className="block w-full text-left px-3 py-1.5 text-[11px] text-text-secondary hover:bg-surface-hover hover:text-text-primary transition-colors"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

// ── Board state ───────────────────────────────────────────────────────────────

interface Tab  { id: string; type: WidgetType }
interface Item { id: string; tabs: Tab[]; active: number }

const one = (id: string, type: WidgetType): Item => ({
  id, tabs: [{ id: `${id}-t0`, type }], active: 0,
});

const INITIAL_ITEMS: Item[] = [
  one('big', 'chart'),
  { id: 'rect', tabs: [{ id: 'rect-t0', type: 'payoff' }, { id: 'rect-t1', type: 'analytics' }, { id: 'rect-t2', type: 'landscape' }], active: 0 },
  one('panel-top', 'bands'),
  one('panel-bottom', 'order'),
];

const INITIAL_LAYOUT: Layout = [
  { i: 'big',          x: 0, y: 0, w: 8, h: 8, minW: 3, minH: 4 },
  { i: 'rect',         x: 0, y: 8, w: 8, h: 4, minW: 3, minH: 2 },
  { i: 'panel-top',    x: 8, y: 0, w: 4, h: 6, minW: 2, minH: 3 },
  { i: 'panel-bottom', x: 8, y: 6, w: 4, h: 6, minW: 2, minH: 3 },
];

// ── Page ──────────────────────────────────────────────────────────────────────

const GridPage = () => {
  const [items,  setItems]  = useState<Item[]>(INITIAL_ITEMS);
  const [layout, setLayout] = useState<Layout>(INITIAL_LAYOUT);
  const { ref, width, rowHeight } = useGridSize();
  const s      = useGridState();
  const nextId = useRef(0);

  const selectTab  = (itemId: string, i: number) =>
    setItems(prev => prev.map(it => it.id === itemId ? { ...it, active: i } : it));

  const addTab = (itemId: string, type: WidgetType) =>
    setItems(prev => prev.map(it =>
      it.id === itemId
        ? { ...it, tabs: [...it.tabs, { id: `t${++nextId.current}`, type }], active: it.tabs.length }
        : it,
    ));

  const closeTab = (itemId: string, i: number) =>
    setItems(prev => prev.map(it => {
      if (it.id !== itemId || it.tabs.length === 1) return it;
      const tabs   = it.tabs.filter((_, idx) => idx !== i);
      const active = i <= it.active ? Math.max(0, it.active - 1) : it.active;
      return { ...it, tabs, active };
    }));

  const removeWidget = (id: string) => {
    setItems(prev  => prev.filter(it => it.id !== id));
    setLayout(prev => prev.filter(l  => l.i  !== id));
  };

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
            {items.map(item => {
              const activeTab = item.tabs[item.active] ?? item.tabs[0]!;
              return (
                <div key={item.id} className="h-full">
                  <Widget
                    tabs={item.tabs.map(t => ({ id: t.id, label: CATALOG[t.type].label }))}
                    active={item.active}
                    options={ADD_OPTIONS}
                    content={CATALOG[activeTab.type].render(s)}
                    onSelect={i  => selectTab(item.id, i)}
                    onAddTab={t  => addTab(item.id, t as WidgetType)}
                    onCloseTab={i => closeTab(item.id, i)}
                    onClose={() => removeWidget(item.id)}
                  />
                </div>
              );
            })}
          </ReactGridLayout>
        </div>
      </div>
    </div>
  );
};

export default GridPage;
