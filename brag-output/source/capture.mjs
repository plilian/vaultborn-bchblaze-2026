// Usage: node capture.mjs stills <out-dir> t1 t2 ...   |   node capture.mjs render <out.mp4> <startFrame> <endFrame>
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { spawn } from 'node:child_process';
import { writeFileSync, renameSync } from 'node:fs';

const [mode, out, ...rest] = process.argv.slice(2);
const FPS = 30;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto('http://127.0.0.1:8765/stage/index.html');
await page.evaluate(() => window.ready);
const errors = [];
page.on('pageerror', e => errors.push(String(e)));

async function frame(t) {
  await page.evaluate(t => window.renderAt(t), t);
  return page.screenshot({ type: 'jpeg', quality: 92 });
}

if (mode === 'stills') {
  for (const s of rest) {
    const t = Number(s);
    const buf = await frame(t);
    writeFileSync(`${out}/t${t.toFixed(2).padStart(6, '0')}.jpg`, buf);
  }
} else if (mode === 'render') {
  const [a, b] = rest.map(Number);
  const tmp = out.replace(/\.mp4$/, '.part.mp4');
  const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', '60', '-movflags', '+faststart', tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', c => (c === 0 ? res() : rej(new Error('ffmpeg ' + c)))));
  for (let f = a; f < b; f++) {
    const buf = await frame(f === 0 && process.env.POSTER_T ? Number(process.env.POSTER_T) : f / FPS);
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await done;
  renameSync(tmp, out);
}
if (errors.length) console.error('PAGE ERRORS:', errors.join('\n'));
await browser.close();
