import { type RouteConfig, index, route } from '@react-router/dev/routes'

export default [
  index('routes/home/route.tsx'),
  route('markets/:slug', 'routes/markets.$slug/route.tsx'),
] satisfies RouteConfig
