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
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand-500 text-white shadow-sm">
        <Shirt size={18} />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-extrabold text-ink-900">Vinted Studio</p>
        <p className="text-[11px] font-medium text-ink-400">Asystent sprzedaży</p>
      </div>
    </Link>
  )
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1">
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

  return (
    <div className="min-h-full lg:flex">
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-ink-100 bg-white px-3 py-4 lg:flex">
        <Brand />
        <div className="mt-6 flex-1">
          <NavItems />
        </div>
        <p className="px-3 text-[11px] leading-relaxed text-ink-400">
          Działa lokalnie w przeglądarce. Dane i klucz API nie opuszczają tego urządzenia.
        </p>
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-ink-100 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
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
          <div className="absolute inset-0 bg-ink-950/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-72 bg-white p-3 shadow-pop">
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
            className="flex items-center gap-2 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-800 hover:bg-amber-100"
          >
            <AlertTriangle size={16} />
            Dodaj klucz API Gemini w Ustawieniach, aby włączyć generowanie zdjęć i opisów.
          </Link>
        )}
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
