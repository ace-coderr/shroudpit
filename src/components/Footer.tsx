export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer__inner">
        <span className="footer__name">Shroudpit</span>
        <nav className="footer__links" aria-label="Project links">
          <a href="https://github.com/ace-coderr/shroudpit" target="_blank" rel="noreferrer">GitHub</a>
          <a href="https://github.com/ace-coderr/shroudpit/blob/main/docs/audit-checklist.md" target="_blank" rel="noreferrer">Audit</a>
        </nav>
        <div className="footer__net">
          <span className="devnet">devnet</span>
          <span>Sample leagues run on Solana devnet.</span>
        </div>
      </div>
    </footer>
  )
}
