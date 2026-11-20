import { useState } from 'react'
import { NavLink } from 'react-router-dom'

// Links are added as each module ships; nothing here points at a page that does not exist.
const links = [{ to: '/', label: 'Overview', end: true }]

export default function Navbar() {
  const [open, setOpen] = useState(false)
  return (
    <header className="nav">
      <div className="nav__inner">
        <NavLink to="/" className="brand" onClick={() => setOpen(false)}>
          <span className="brand__mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand__name">Shroudpit</span>
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
        </nav>
      </div>
    </header>
  )
}
