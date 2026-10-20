// Use the installed browser on Windows: the Chrome 126 bundled by Miniflare
// fails Windows side-by-side assembly resolution on some installations.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

if (process.platform === 'win32') {
  const candidates = [
    process.env.LOCAL_CHROME_PATH,
    path.join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  const installed = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (installed) {
    const spawn = childProcess.spawn;
    childProcess.spawn = function (file, ...args) {
      if (typeof file === 'string' && /[\\/]\.wrangler[\\/]chrome[\\/].*[\\/]chrome\.exe$/i.test(file)) {
        file = installed;
      }
      return spawn.call(this, file, ...args);
    };
    require('node:module').syncBuiltinESMExports();
    // Wrangler starts a child Node process; keep the same local browser override.
    const preload = `--require ${JSON.stringify(__filename)}`;
    if (!(process.env.NODE_OPTIONS || '').includes(__filename)) {
      process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} ${preload}`.trim();
    }
  }
}
