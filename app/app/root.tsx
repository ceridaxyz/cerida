import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from 'react-router'
import type { ReactNode } from 'react'
import type { Route } from './+types/root'
import './app.css'

export const Layout = ({ children }: { children: ReactNode }) => (
  <html lang="en" className="h-full antialiased">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <Meta />
      <Links />
    </head>
    <body className="min-h-full flex flex-col">
      {children}
      <ScrollRestoration />
      <Scripts />
    </body>
  </html>
)

const App = () => <Outlet />

export default App

export const ErrorBoundary = ({ error }: Route.ErrorBoundaryProps) => {
  let message = 'Oops!'
  let details = 'An unexpected error occurred.'
  let stack: string | undefined

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error'
    details = error.status === 404 ? 'The requested page could not be found.' : error.statusText || details
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message
    stack = error.stack
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <h1 className="text-4xl font-bold">{message}</h1>
      <p className="mt-4 text-center">{details}</p>
      {stack && (
        <pre className="mt-8 w-full max-w-2xl overflow-x-auto rounded p-4 font-mono text-sm">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  )
}
