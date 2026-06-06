import type { Route } from './+types/route.js'
import Navbar from '../../components/navbar'
import AlertBanner from '../../components/alert-banner'
import MarketCard from '../../components/markets/market-card'
import { MARKETS } from '../../data/markets'

export const meta = (): Route.MetaDescriptors => [
  { title: 'Markets — Ultramarkets' },
  { name: 'description', content: 'Prediction markets with leverage' },
]

const CATEGORIES = ['All', 'Crypto', 'Stocks', 'Macro', 'Politics', 'Sports']

const HomePage = () => {
  return (
    <div className="flex flex-col min-h-screen bg-surface-primary">
      <Navbar />
      <AlertBanner />

      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-6">
        {/* Page header */}
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-[22px] font-medium text-text-primary" style={{ fontFamily: 'Barlow, sans-serif' }}>
            All Markets
          </h2>
          <span className="text-[13px] text-text-tertiary">{MARKETS.length} markets</span>
        </div>

        {/* Category filter */}
        <div className="flex items-center gap-2 mb-6 overflow-x-auto pb-1">
          {CATEGORIES.map((cat, i) => (
            <button
              key={cat}
              className={`px-4 py-1.5 text-[14px] font-medium rounded-full shrink-0 transition-colors ${
                i === 0
                  ? 'bg-brand-violet text-white'
                  : 'bg-surface-card border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-surface-hover'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Market grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {MARKETS.map((market) => (
            <MarketCard key={market.slug} market={market} />
          ))}
        </div>
      </main>
    </div>
  )
}

export default HomePage
