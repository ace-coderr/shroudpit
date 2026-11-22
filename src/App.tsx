import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useEffect } from 'react'
import Footer from './components/Footer'
import Navbar from './components/Navbar'
import Audit from './pages/Audit'
import Create from './pages/Create'
import Desk from './pages/Desk'
import LeagueIndex from './pages/LeagueIndex'
import Lobby from './pages/Lobby'
import Record from './pages/Record'
import Standings from './pages/Standings'

function ScrollTop() {
  const { pathname } = useLocation()
  useEffect(() => window.scrollTo(0, 0), [pathname])
  return null
}

export default function App() {
  const location = useLocation()
  return (
    <div className="shell">
      <ScrollTop />
      <Navbar />
      <main className="main">
        {/* keyed by path so every page change replays the 180ms fade and slide */}
        <div className="pagefx" key={location.pathname}>
          <Routes location={location}>
            <Route path="/" element={<Lobby />} />
            <Route path="/lobby" element={<Navigate to="/" replace />} />
            <Route path="/create" element={<Create />} />
            <Route path="/desk" element={<LeagueIndex target="desk" />} />
            <Route path="/standings" element={<LeagueIndex target="standings" />} />
            <Route path="/desk/:league" element={<Desk />} />
            <Route path="/standings/:league" element={<Standings />} />
            <Route path="/audit/:league" element={<Audit />} />
            <Route path="/record" element={<Record />} />
            <Route path="/record/:wallet" element={<Record />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
      <Footer />
    </div>
  )
}
