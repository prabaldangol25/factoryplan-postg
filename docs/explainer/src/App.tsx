import { Routes, Route, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { Nav, MobileNav } from "@/components/Nav";
import { Home } from "@/pages/Home";
import { FirstPrinciples } from "@/pages/FirstPrinciples";
import { Architecture } from "@/pages/Architecture";
import { Flow } from "@/pages/Flow";
import { Context } from "@/pages/Context";
import { Enhancements } from "@/pages/Enhancements";
import { EnhancementDetail } from "@/pages/EnhancementDetail";

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <div className="flex min-h-screen">
      <Nav />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav />
        <ScrollToTop />
        <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-10 sm:px-8 lg:px-12 lg:py-16">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/first-principles" element={<FirstPrinciples />} />
            <Route path="/architecture" element={<Architecture />} />
            <Route path="/flow" element={<Flow />} />
            <Route path="/context" element={<Context />} />
            <Route path="/enhancements" element={<Enhancements />} />
            <Route path="/enhancements/:slug" element={<EnhancementDetail />} />
          </Routes>
        </main>
        <footer className="border-t border-white/10 px-8 py-6 text-center text-xs text-slate-600">
          Interactive explainer · generated for the factoryplan Ask Agent feature
        </footer>
      </div>
    </div>
  );
}
