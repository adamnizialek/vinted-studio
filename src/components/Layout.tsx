import { useState } from 'react'
import { NavLink, Outlet, Link } from 'react-router-dom'
import {
  Camera,
  LayoutDashboard,
  Menu,
  Package,
  Settings,
  Shirt,
  Users,
  Wallet,
  X,
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

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) => clsx('nav-link', isActive && 'nav-link-active')}
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </nav>
  )
}

export function Layout() {
  const [open, setOpen] = useState(false)
  const settings = useSettings((s) => s.settings)
  const needsKey = settings && !settings.geminiApiKey
  useSyncTriggers()

  return (
    <div className="min-h-full lg:flex">
      {/* Sidebar (desktop) */}
      <aside className="glass sticky top-3 m-3 hidden h-[calc(100vh-24px)] w-[236px] shrink-0 flex-col self-start rounded-2xl px-3 py-5 lg:flex">
        <Brand />
        <div className="mt-6 flex-1">
          <NavItems />
        </div>
        <SyncBadge className="mb-2" />
        <p className="px-2 text-[11.5px] leading-relaxed text-ink-400">
          Klucz API nie opuszcza tego urządzenia. Synchronizację między urządzeniami włączysz w Ustawieniach.
        </p>
      </aside>

      {/* Mobile header */}
      <header className="glass sticky top-0 z-40 flex items-center justify-between px-4 py-3 lg:hidden">
        <Brand />
        <button
          onClick={() => setOpen(true)}
          className="rounded-lg p-2 text-ink-600 hover:bg-ink-100"
          aria-label="Menu"
        >
          <Menu />
        </button>
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-72 bg-ink-50 p-3 shadow-pop">
            <div className="flex items-center justify-between">
              <Brand />
              <button onClick={() => setOpen(false)} className="rounded-lg p-2 text-ink-500 hover:bg-ink-100">
                <X />
              </button>
            </div>
            <div className="mt-6">
              <NavItems onNavigate={() => setOpen(false)} />
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="min-w-0 flex-1">
        {needsKey && (
          <Link
            to="/ustawienia"
            className="mx-4 mt-4 flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2.5 text-sm font-medium sm:mx-6 lg:ml-8 lg:mr-11 lg:mt-9 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300 dark:hover:bg-amber-950/60"
          >
            <AlertTriangle size={16} />
            Dodaj klucz API Gemini w Ustawieniach, aby włączyć generowanie zdjęć i opisów.
          </Link>
        )}
        <div className="max-w-[1240px] px-4 py-6 sm:px-6 lg:pb-16 lg:pl-8 lg:pr-11 lg:pt-9">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
