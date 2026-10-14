// Draws the app's icons from the logo's SVG sources in design/logo. Run with
// `pnpm icons` after changing the logo; the PNGs it writes are committed.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

const root = join(__dirname, '..');
const outputs = [
  ['icon-mac.svg', 1024, 'apps/desktop/resources/icon.png'],
  ['menu-bar.svg', 16, 'apps/desktop/resources/trayTemplate.png'],
  ['menu-bar.svg', 32, 'apps/desktop/resources/trayTemplate@2x.png'],
  ['icon-iphone.svg', 1024, 'apps/mobile/assets/icon.png'],
  ['mark.svg', 512, 'design/logo/mark.png'],
];

app.dock?.hide();
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    width: 1024,
    height: 1024,
    webPreferences: { offscreen: true },
  });
  for (const [source, size, target] of outputs) {
    const svg = readFileSync(join(root, 'design/logo', source), 'utf8');
    window.setContentSize(size, size);
    const page = `<html><body style="margin:0;background:transparent"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"></body></html>`;
    await window.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const image = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    // Captures come at the screen's scale; the file must be exactly `size` pixels.
    writeFileSync(
      join(root, target),
      image.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    );
    // Apple refuses an iPhone app icon with an alpha channel, even a fully opaque one.
    if (target.startsWith('apps/mobile/')) {
      const flat = join(require('node:os').tmpdir(), 'opsidian-icon.jpg');
      execFileSync(
        'sips',
        ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', target, '--out', flat],
        { cwd: root },
      );
      execFileSync('sips', ['-s', 'format', 'png', flat, '--out', target], { cwd: root });
    }
    console.log(`${target} (${size} px)`);
  }
  // The packaged Mac app wants every size in one .icns file, made from the 1024 px icon.
  const set = join(require('node:os').tmpdir(), 'opsidian.iconset');
  require('node:fs').rmSync(set, { recursive: true, force: true });
  require('node:fs').mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      execFileSync('sips', [
        '-z',
        String(size * scale),
        String(size * scale),
        join(root, 'apps/desktop/resources/icon.png'),
        '--out',
        join(set, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
      ]);
  execFileSync('iconutil', [
    '-c',
    'icns',
    set,
    '-o',
    join(root, 'apps/desktop/packaging/icon.icns'),
  ]);
  console.log('apps/desktop/packaging/icon.icns');
  app.exit(0);
});
