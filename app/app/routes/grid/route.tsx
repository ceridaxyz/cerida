import TopNav from '../../components/market/top-nav';
import { useGridState } from '../../components/grid/use-grid-state';
import GridChart from '../../components/grid/grid-chart';
import RightPanel from '../../components/grid/right-panel';

export const meta = () => [{ title: 'Grid — Cerida' }];

const GridPage = () => {
  const s = useGridState();
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="px-2 pt-2 shrink-0 relative z-30">
        <TopNav />
      </div>
      <div className="flex flex-1 min-w-0 overflow-hidden">
        {/* Chart — fills all remaining space */}
        <div className="flex-1 min-w-0 overflow-hidden">
          <GridChart s={s} />
        </div>
        {/* Right panel — fixed width, Blip Markets style */}
        <div
          className="w-96 shrink-0 border-l border-border-subtle overflow-hidden flex flex-col"
          style={{ background: 'var(--color-surface-primary)' }}
        >
          <RightPanel s={s} />
        </div>
      </div>
    </div>
  );
};

export default GridPage;
