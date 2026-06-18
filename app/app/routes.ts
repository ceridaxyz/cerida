import { type RouteConfig, index, route } from '@react-router/dev/routes'

export default [
  index('routes/home/route.tsx'),
  route('trade', 'routes/markets.$slug/route.tsx'),
  route('trade/grid', 'routes/grid/route.tsx'),
  route('portfolio', 'routes/portfolio/route.tsx'),
] satisfies RouteConfig
