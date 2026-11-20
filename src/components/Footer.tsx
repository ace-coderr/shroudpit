export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer__inner">
        <div className="footer__brand">
          <span className="footer__name">Shroudpit</span>
          <p>Private trading leagues with a verifiable skill record.</p>
        </div>
        <ul className="footer__meta">
          <li>Solana devnet</li>
          <li>Paper positions on live prices</li>
          <li>
            <a href="https://github.com/ace-coderr/shroudpit" target="_blank" rel="noreferrer">
              Source
            </a>
          </li>
        </ul>
      </div>
      <p className="footer__legal">
        Paper trading only. No real funds are staked and nothing here is financial advice.
      </p>
    </footer>
  )
}
