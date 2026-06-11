import type { Route } from './+types/route.js';
import Sidebar from '../../components/sidebar';

export const meta = (): Route.MetaDescriptors => [
  { title: 'Markets — Cerida' },
  { name: 'description', content: 'Prediction markets with leverage' },
];

const HomePage = () => {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />

      <div className="flex flex-col flex-1 overflow-hidden">
        {/* <AlertBanner /> */}

        <main className="flex-1 overflow-auto px-6 py-6"></main>
      </div>
    </div>
  );
};

export default HomePage;
