// Renders build/icon.svg into the icon files electron-builder picks up from build/:
// icon.png (1024), icon.icns (macOS) and icon.ico (Windows), plus src/renderer/icon.png for the window.
// Needs Playwright with Chromium: `node scripts/make-icons.js` after editing the SVG.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'build', 'icon.svg'), 'utf8');

async function renderAll(sizes) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = {};
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    const sized = svg.replace(/width="1024" height="1024"/, `width="${size}" height="${size}"`);
    await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
    out[size] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await browser.close();
  return out;
}

// ICNS: 'icns' + total length, then one (type, length, PNG data) chunk per size.
function icns(png) {
  const types = [['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512]];
  const chunks = types.map(([type, size]) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png[size].length + 8, 4);
    return Buffer.concat([head, png[size]]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

// ICO with PNG-compressed entries (Windows Vista and later).
function ico(png, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const dir = sizes.map((size) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png[size].length, 8); e.writeUInt32LE(offset, 12);
    offset += png[size].length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...sizes.map((s) => png[s])]);
}

(async () => {
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const png = await renderAll([...new Set([16, 24, 32, 48, 64, 128, 256, 512, 1024])]);
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), png[1024]);
  fs.writeFileSync(path.join(root, 'build', 'icon.icns'), icns(png));
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(png, icoSizes));
  fs.writeFileSync(path.join(root, 'src', 'renderer', 'icon.png'), png[512]);
  console.log('Wrote build/icon.png, build/icon.icns, build/icon.ico, src/renderer/icon.png');
})();
