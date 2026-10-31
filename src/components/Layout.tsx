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
import { SyncBadge, useSyncTriggers } from '@/components/SyncStatus'

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

const KEY_NOTE = 'Klucz API nie opuszcza tego urządzenia. Synchronizację między urządzeniami włączysz w Ustawieniach.'

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-2 py-1">
      <div className="grid h-7 w-7 place-items-center rounded-lg bg-brand-500 text-white">
        <Shirt size={15} />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-ink-900">Vinted Studio</p>
        <p className="text-[11.5px] text-ink-500">Asystent sprzedaży</p>
      </div>
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
  const tabCls = 'flex flex-1 flex-col items-center gap-0.5 pb-1 pt-2 text-[10.5px] font-medium transition'
  return (
    <nav className="glass fixed inset-x-0 bottom-0 z-40 flex px-2 pb-[env(safe-area-inset-bottom)] lg:hidden">
      {TABS.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) =>
            clsx(tabCls, isActive && !moreOpen ? 'text-brand-500' : 'text-ink-500 active:text-ink-700')
          }
        >
          <Icon size={22} strokeWidth={1.8} />
          {label}
        </NavLink>
      ))}
      <button
        type="button"
        onClick={onMore}
        aria-expanded={moreOpen}
        className={clsx(tabCls, inMore || moreOpen ? 'text-brand-500' : 'text-ink-500 active:text-ink-700')}
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
      <aside className="glass sticky top-3 m-3 hidden h-[calc(100vh-24px)] w-[236px] shrink-0 flex-col self-start rounded-2xl px-3 py-5 lg:flex">
        <Brand />
        <div className="mt-6 flex-1">
          <NavItems />
        </div>
        <SyncBadge className="mb-2" />
        <p className="px-2 text-[11.5px] leading-relaxed text-ink-400">{KEY_NOTE}</p>
      </aside>

      {/* Mobile header */}
      <header className="glass sticky top-0 z-40 flex items-center px-2 pb-1.5 pt-[calc(env(safe-area-inset-top)+0.375rem)] lg:hidden">
        <Brand />
      </header>

      {/* Mobile „Więcej” sheet — nad paskiem kart */}
      {moreOpen && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setMoreOpen(false)} />
          <div className="absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.25rem)] flex flex-col gap-3 rounded-2xl bg-ink-50 p-3 shadow-pop">
            <NavItems items={MORE} />
            <SyncBadge className="bg-surface" />
            <p className="px-2 text-[11.5px] leading-relaxed text-ink-400">{KEY_NOTE}</p>
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
