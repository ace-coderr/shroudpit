import { Route, Routes, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import Footer from './components/Footer'
import Navbar from './components/Navbar'
import Audit from './pages/Audit'
import Create from './pages/Create'
import Desk from './pages/Desk'
import Home from './pages/Home'
import Lobby from './pages/Lobby'
import Record from './pages/Record'
import Standings from './pages/Standings'

function ScrollTop() {
  const { pathname } = useLocation()
  useEffect(() => window.scrollTo(0, 0), [pathname])
  return null
}

export default function App() {
  return (
    <div className="shell">
      <ScrollTop />
      <Navbar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/lobby" element={<Lobby />} />
          <Route path="/create" element={<Create />} />
          <Route path="/desk/:league" element={<Desk />} />
          <Route path="/standings/:league" element={<Standings />} />
          <Route path="/audit/:league" element={<Audit />} />
          <Route path="/record" element={<Record />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}
