import { useEffect } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { Layout } from '@/components/Layout'
import { Toasts } from '@/components/Toasts'
import { useSettings } from '@/state/settings'
import { Dashboard } from '@/pages/Dashboard'
import { Inventory } from '@/pages/Inventory'
import { ProductEditor } from '@/pages/ProductEditor'
import { PhotoStudio } from '@/pages/PhotoStudio'
import { Models } from '@/pages/Models'
import { Sales } from '@/pages/Sales'
import { Accounts } from '@/pages/Accounts'
import { SettingsPage } from '@/pages/Settings'

export default function App() {
  const load = useSettings((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])

  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="magazyn" element={<Inventory />} />
          <Route path="magazyn/:id" element={<ProductEditor />} />
          <Route path="magazyn/model/:designId" element={<ProductEditor />} />
          <Route path="studio" element={<PhotoStudio />} />
          <Route path="studio/:productId" element={<PhotoStudio />} />
          <Route path="modelki" element={<Models />} />
          <Route path="sprzedaz" element={<Sales />} />
          <Route path="konta" element={<Accounts />} />
          <Route path="ustawienia" element={<SettingsPage />} />
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
      <Toasts />
    </HashRouter>
  )
}
