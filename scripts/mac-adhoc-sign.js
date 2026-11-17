/**
 * electron-builder afterPack hook for the downloadable macOS build
 * (`npm run dist:release:mac`): ad-hoc sign the whole Bloom.app before the
 * .dmg is made.
 *
 * Why: there is no Apple Developer ID, and electron-builder 25 doesn't ad-hoc
 * sign on its own — with no identity it skips signing entirely, leaving only
 * the linker's signature on the main executable, which no longer matches the
 * bundle once electron-builder has renamed it and added Bloom's resources.
 * Downloaded on Apple Silicon, a bundle like that gets Gatekeeper's "is
 * damaged and can't be opened" dialog, which has no way past it. A valid
 * ad-hoc signature instead gets the ordinary "Apple could not verify…"
 * dialog, which the user can override in System Settings → Privacy &
 * Security.
 *
 * No hardened runtime and no entitlements: hardened runtime only matters for
 * notarization, and without its entitlements Electron's JIT would not run.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  console.log(`[bloom] ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  // Fail the build rather than ship a bundle Gatekeeper will call damaged.
  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' },
  );
}
