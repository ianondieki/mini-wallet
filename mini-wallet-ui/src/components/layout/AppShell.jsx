import { Outlet, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import Background from '../ui/Background.jsx';
import Sidebar from './Sidebar.jsx';
import BottomNav from './BottomNav.jsx';

/**
 * Authenticated app frame: atmospheric background, persistent navigation,
 * and an animated outlet that fade-slides between routes.
 */
export default function AppShell() {
  const location = useLocation();

  return (
    <div className="relative min-h-screen">
      <Background />
      <Sidebar />

      <main className="relative z-10 px-4 pb-24 pt-6 md:pl-24 md:pr-6 lg:pl-72">
        <div className="mx-auto w-full max-w-5xl">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <BottomNav />
    </div>
  );
}
