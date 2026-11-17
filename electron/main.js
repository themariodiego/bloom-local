/**
 * Electron shell. The Express backend runs inside this process on a random
 * loopback port — one process, no orphaned servers, nothing exposed off-box.
 */
import { app, BrowserWindow, Menu, MenuItem, shell, dialog } from 'electron';
import path from 'node:path';
import { readFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';

// A GUI launch inherits a minimal PATH, so the `claude` binary would be
// invisible. Put the usual install locations back before anything spawns it.
const home = app.getPath('home');
const EXTRA_PATH =
  process.platform === 'win32'
    ? [
        // Native installer (claude.exe), npm global shims, WinGet links.
        path.join(home, '.local', 'bin'),
        path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm'),
        path.join(
          process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
          'Microsoft', 'WinGet', 'Links',
        ),
      ]
    : [
        '/usr/local/bin',
        '/opt/homebrew/bin',
        path.join(home, '.local/bin'),
        path.join(home, '.claude/local'),
        path.join(home, '.bun/bin'),
        path.join(home, '.npm-global/bin'),
      ];
process.env.PATH = [
  ...new Set([...(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATH]),
]
  .filter(Boolean)
  .join(path.delimiter);

/**
 * Choose where Bloom keeps its data, honouring "everything stays local".
 *   - running from source  → app/data/, beside the code
 *   - packaged .app        → "Bloom Data" beside the .app bundle, since the
 *                            bundle itself is read-only
 *   - packaged, elsewhere  → the per-user app-data folder (an installed
 *                            Program Files directory isn't writable either)
 * Override any of them with BLOOM_DATA_DIR.
 */
function resolveDataDir() {
  if (process.env.BLOOM_DATA_DIR) return process.env.BLOOM_DATA_DIR;
  if (!app.isPackaged) return path.join(here, '..', 'data');

  // Prefer the checkout's data directory recorded at build time, so the
  // packaged app and `npm start` share one database.
  try {
    const baked = JSON.parse(
      readFileSync(path.join(here, 'data-dir.json'), 'utf8'),
    ).dataDir;
    accessSync(path.dirname(baked), fsConstants.W_OK);
    return baked;
  } catch {
    // Checkout moved or deleted — fall back to a folder beside the bundle.
    // .../Bloom.app/Contents/MacOS/Bloom → the folder holding Bloom.app
    if (isMac) {
      return path.join(path.dirname(app.getPath('exe')), '..', '..', '..', 'Bloom Data');
    }
    return path.join(app.getPath('userData'), 'data');
  }
}

/**
 * Right-click menu with spelling corrections.
 *
 * Chromium's spellchecker is already on by default and already finds the
 * typos — but Electron ships no default context menu, so right-clicking a
 * squiggled word does nothing until we build the menu from the event params.
 */
function attachContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const menu = new Menu();

    // Corrections first — this is what you're reaching for.
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        }),
      );
    }

    if (params.misspelledWord) {
      if (params.dictionarySuggestions.length === 0) {
        menu.append(
          new MenuItem({ label: 'No spelling suggestions', enabled: false }),
        );
      }
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(
        new MenuItem({
          label: `Add “${params.misspelledWord}” to dictionary`,
          click: () =>
            win.webContents.session.addWordToSpellCheckerDictionary(
              params.misspelledWord,
            ),
        }),
      );
      menu.append(new MenuItem({ type: 'separator' }));
    }

    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'undo', enabled: params.editFlags.canUndo }));
      menu.append(new MenuItem({ role: 'redo', enabled: params.editFlags.canRedo }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ role: 'selectAll' }));
      menu.append(new MenuItem({ type: 'separator' }));
      // These roles are wired to native macOS text services; elsewhere they
      // would render as items that do nothing.
      if (isMac) {
        menu.append(
          new MenuItem({
            label: 'Substitutions',
            submenu: [
              { role: 'showSubstitutions' },
              { type: 'separator' },
              { role: 'toggleSmartQuotes' },
              { role: 'toggleSmartDashes' },
              { role: 'toggleTextReplacement' },
            ],
          }),
        );
      }
      menu.append(new MenuItem({ role: 'toggleSpellChecker' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    }

    // An empty menu pops a stray grey rectangle.
    if (menu.items.length > 0) menu.popup({ window: win });
  });
}

let mainWindow = null;

async function boot() {
  process.env.BLOOM_DATA_DIR = path.resolve(resolveDataDir());
  console.log(`[bloom] data directory: ${process.env.BLOOM_DATA_DIR}`);

  // A bare absolute path is not a valid ESM specifier — it must be a file:// URL.
  const serverUrl = pathToFileURL(path.join(here, '..', 'server', 'index.js')).href;
  const { startServer } = await import(serverUrl);
  const { port } = await startServer(0);
  console.log(`[bloom] serving on http://127.0.0.1:${port}`);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 600,
    title: 'Bloom',
    backgroundColor: '#F7F5F0',
    // macOS gets the inset traffic lights over our own chrome; Windows and
    // Linux keep their native frame, minus the File/Edit menu bar we don't use
    // (Alt still reveals it).
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 22 } }
      : { autoHideMenuBar: true }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // External links open in the real browser, not inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  attachContextMenu(mainWindow);

  // Tell the frontend it's inside the frameless shell, so it leaves room for
  // the traffic lights. A browser (the iPad) gets no such marker and reclaims
  // that strip. HashRouter keeps the query string across navigation. Only the
  // macOS window is frameless; elsewhere the native title bar already
  // provides the drag area, so load the page as a browser would.
  await mainWindow.loadURL(
    `http://127.0.0.1:${port}/${isMac ? '?shell=electron' : ''}`,
  );
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() =>
  boot().catch((err) => {
    // Log as well as alert — a modal alone is invisible when launched from a shell.
    console.error('[bloom] failed to start:', err?.stack ?? err);
    dialog.showErrorBox('Bloom could not start', String(err?.stack ?? err));
    app.quit();
  }),
);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) boot();
});
