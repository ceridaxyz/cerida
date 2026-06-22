import { redirect } from 'react-router'

export function loader() {
  return redirect('/trade')
}

export default function Home() {
  return null
}
