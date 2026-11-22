import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import WalletButton from './WalletButton'

const links = [
  { to: '/', label: 'Lobby', end: true },
  { to: '/desk', label: 'Desk', end: false },
  { to: '/standings', label: 'Standings', end: false },
  { to: '/record', label: 'Record', end: false },
]

export default function Navbar() {
  const [open, setOpen] = useState(false)
  return (
    <header className="nav">
      <div className="nav__inner">
        <NavLink to="/" className="wordmark" onClick={() => setOpen(false)}>
          <span className="wordmark__mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Shroudpit
        </NavLink>
        <button
          className={`nav__toggle${open ? ' is-open' : ''}`}
          aria-expanded={open}
          aria-controls="primary-nav"
          aria-label="Toggle navigation"
          onClick={() => setOpen((v) => !v)}
        >
          <span />
          <span />
        </button>
        <nav id="primary-nav" className={`nav__links${open ? ' is-open' : ''}`}>
          {links.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.end}
              className={({ isActive }) => `nav__link${isActive ? ' is-active' : ''}`}
              onClick={() => setOpen(false)}
            >
              {l.label}
            </NavLink>
          ))}
          <WalletButton />
        </nav>
      </div>
    </header>
  )
}
