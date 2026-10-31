import { useEffect, useState } from 'react'
import { NavLink, Outlet, Link, useLocation } from 'react-router-dom'
import {
  Camera,
  LayoutDashboard,
  MoreHorizontal,
  Package,
  Settings,
  Shirt,
  Users,
  Wallet,
  AlertTriangle,
} from 'lucide-react'
import clsx from 'clsx'
import { useSettings } from '@/state/settings'
import { SyncDot, useSyncTriggers } from '@/components/SyncStatus'

const NAV = [
  { to: '/', label: 'Pulpit', icon: LayoutDashboard, end: true },
  { to: '/magazyn', label: 'Magazyn', icon: Package },
  { to: '/studio', label: 'Studio zdjęć', icon: Camera },
  { to: '/modelki', label: 'Modelki AI', icon: Shirt },
  { to: '/sprzedaz', label: 'Sprzedaż', icon: Wallet },
  { to: '/konta', label: 'Konta', icon: Users },
  { to: '/ustawienia', label: 'Ustawienia', icon: Settings },
]

// Dolny pasek kart na telefonie: cztery najczesciej uzywane ekrany, reszta w „Więcej”.
const TABS = [
  { to: '/', label: 'Pulpit', icon: LayoutDashboard, end: true },
  { to: '/magazyn', label: 'Magazyn', icon: Package },
  { to: '/studio', label: 'Studio', icon: Camera },
  { to: '/sprzedaz', label: 'Sprzedaż', icon: Wallet },
]
const MORE = NAV.filter((n) => !TABS.some((t) => t.to === n.to))

// Znak „V-wzrost”: litera V jako ptaszek „sprzedane” i linia wzrostu. Grubsza kreska niz w ikonie PWA,
// bo przy 28px cienka ginie.
function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" className={className} aria-hidden="true">
      <rect width="1024" height="1024" rx="230" fill="#0f7c78" />
      <path d="M 290 440 L 450 680" fill="none" stroke="#b8f0e0" strokeWidth="140" strokeLinecap="round" />
      <path d="M 450 680 L 740 300" fill="none" stroke="#fff" strokeWidth="140" strokeLinecap="round" />
    </svg>
  )
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-2 py-1">
      <LogoMark className="h-7 w-7" />
      <p className="text-sm font-semibold leading-tight text-ink-900">Vinted Studio</p>
    </Link>
  )
}

function NavItems({ items = NAV }: { items?: typeof NAV }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {items.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => clsx('nav-link', isActive && 'nav-link-active')}
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}

function TabBar({ moreOpen, onMore }: { moreOpen: boolean; onMore: () => void }) {
  const { pathname } = useLocation()
  const inMore = MORE.some((m) => pathname.startsWith(m.to))
  const tabCls =
    'flex flex-1 flex-col items-center gap-0.5 rounded-full py-1.5 text-[10.5px] font-medium transition active:scale-95'
  const on = 'bg-ink-950/[0.06] text-brand-500 dark:bg-white/10'
  const off = 'text-ink-700 active:bg-ink-950/[0.04]'
  // Pływająca „kapsuła” w stylu iOS 26: odsunięta od krawędzi, aktywna karta ma własną bańkę.
  return (
    <nav className="glass fixed inset-x-3 mx-auto max-w-[26rem] bottom-[max(0.75rem,calc(env(safe-area-inset-bottom)-0.25rem))] z-40 flex rounded-full p-1 lg:hidden">
      {TABS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => clsx(tabCls, isActive && !moreOpen ? on : off)}
        >
          <Icon size={22} strokeWidth={1.8} />
          {label}
        </NavLink>
      ))}
      <button
        type="button"
        onClick={onMore}
        aria-expanded={moreOpen}
        className={clsx(tabCls, inMore || moreOpen ? on : off)}
      >
        <MoreHorizontal size={22} strokeWidth={1.8} />
        Więcej
      </button>
    </nav>
  )
}

export function Layout() {
  const [moreOpen, setMoreOpen] = useState(false)
  const { pathname } = useLocation()
  const settings = useSettings((s) => s.settings)
  const needsKey = settings && !settings.geminiApiKey
  useSyncTriggers()

  useEffect(() => setMoreOpen(false), [pathname])

  return (
    <div className="min-h-full lg:flex">
      {/* Sidebar (desktop) */}
      <aside className="glass sticky top-3 m-3 hidden h-[calc(100vh-24px)] w-[236px] shrink-0 flex-col self-start rounded-[28px] px-3 py-5 lg:flex">
        <div className="flex items-center justify-between pr-1">
          <Brand />
          <SyncDot />
        </div>
        <div className="mt-6 flex-1">
          <NavItems />
        </div>
      </aside>

      {/* Mobile header */}
      <header className="glass sticky top-0 z-40 flex items-center px-2 pb-1.5 pt-[calc(env(safe-area-inset-top)+0.375rem)] [box-shadow:inset_0_-1px_0_var(--glass-stroke)] lg:hidden">
        <Brand />
        <SyncDot className="ml-auto mr-2" />
      </header>

      {/* Mobile „Więcej” sheet — nad paskiem kart */}
      {moreOpen && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-black/20" onClick={() => setMoreOpen(false)} />
          <div className="glass-thick absolute inset-x-3 mx-auto max-w-[26rem] bottom-[calc(max(0.75rem,calc(env(safe-area-inset-bottom)-0.25rem))+4.5rem)] flex flex-col gap-3 rounded-[28px] p-3">
            <NavItems items={MORE} />
          </div>
        </div>
      )}

      {/* Content */}
      <main className="mx-auto min-w-0 max-w-[1680px] flex-1">
        {needsKey && (
          <Link
            to="/ustawienia"
            className="mx-4 mt-4 flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2.5 text-sm font-medium sm:mx-6 lg:ml-8 lg:mr-11 lg:mt-9 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
          >
            <AlertTriangle size={16} />
            Dodaj klucz API Gemini w Ustawieniach, aby włączyć generowanie zdjęć i opisów.
          </Link>
        )}
        <div className="px-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] pt-5 sm:px-6 lg:pb-16 lg:pl-8 lg:pr-11 lg:pt-9">
          <Outlet />
        </div>
      </main>

      <TabBar moreOpen={moreOpen} onMore={() => setMoreOpen((o) => !o)} />
    </div>
  )
}
