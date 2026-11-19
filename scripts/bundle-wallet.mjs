import { build } from 'esbuild';

await build({
  entryPoints:['scripts/wizardconnect-entry.mjs'], outfile:'apps/web/vendor/wizardconnect.js',
  bundle:true, minify:true, format:'esm', platform:'browser', target:'es2022',
  alias:{'isomorphic-ws':'./scripts/wizardconnect-browser-socket.mjs'},
  legalComments:'eof',
  banner: { js:'/* Generated from scripts/wizardconnect-entry.mjs. WizardConnect (C) 2026 Whiterun LLC, LGPL-3.0-or-later. */' },
});
