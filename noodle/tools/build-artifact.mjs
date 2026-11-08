// Inline Noodle into one HTML file for publishing as a claude.ai Artifact.
// Usage: node noodle/tools/build-artifact.mjs <out.html>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] || join(root, 'dist', 'noodle-artifact.html');
let html = readFileSync(join(root, 'index.html'), 'utf8');

const css = readFileSync(join(root, 'style.css'), 'utf8');
// Artifact frame: it already pads top/bottom for the phone's safe areas,
// and wants a 16px side gutter.
const frameCss = `
#app { padding-top: 8px; padding-bottom: 8px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px)); }`;

const head = html.match(/<head>([\s\S]*?)<\/head>/)[1];
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1];
const fonts = head.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0];

const inlined = body.replace(/<script src="(js\/[\w.]+)"><\/script>/g,
  (_, src) => `<script>\n${readFileSync(join(root, src), 'utf8')}\n</script>`);

const page = `<title>Noodle</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
${fonts}
<style>
${css}
${frameCss}
</style>
${inlined}`;
writeFileSync(out, page);
console.log('wrote', out, (page.length / 1024).toFixed(1) + ' KB');
