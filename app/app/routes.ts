import { type RouteConfig, index, route, layout } from '@react-router/dev/routes'

export default [
  layout('routes/layout.tsx', [
    index('routes/home/route.tsx'),
    route('trade', 'routes/markets.$slug/route.tsx'),
    route('trade/grid', 'routes/grid/route.tsx'),
    route('portfolio', 'routes/portfolio/route.tsx'),
  ])
] satisfies RouteConfig
