import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import App from './App.jsx';

// Only the frameless Electron shell gets traffic-light clearance and drag
// regions; a browser on the iPad must not, or it wastes a strip of screen.
// The shell flags itself via ?shell=electron — sniffing the user agent would
// also match any other Electron-based browser pointed at the same URL.
if (new URLSearchParams(window.location.search).get('shell') === 'electron') {
  document.documentElement.classList.add('is-electron');
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
