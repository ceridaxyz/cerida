import type { Route } from './+types/route.js'

export const meta = (): Route.MetaDescriptors => [
  { title: 'cerida' },
  { name: 'description', content: '' },
]

const HomePage = () => (
  <main className="flex min-h-screen flex-col items-center justify-center">
    <h1 className="text-2xl font-semibold">cerida</h1>
  </main>
)

export default HomePage
