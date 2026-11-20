# Included components

The wallet bundle includes WizardConnect by Whiterun LLC, available under LGPL-3.0-or-later. The unmodified browser dependencies are pinned in the package lock. Build the replaceable bundle with npm run build:wallet. [WizardConnect source](https://gitlab.com/riftenlabs/lib/wizardconnect) · [LGPL 3.0](https://www.gnu.org/licenses/lgpl-3.0.html)

The runtime uses Libauth under MIT, QRCode under MIT and the dependency notices preserved in the generated wallet bundle. Playwright, esbuild and the WizardConnect wallet SDK serve local build and test work.

The game art is cataloged in the asset manifest. March of the Riverwardens was composed for VAULTBORN and rendered by scripts/render-score.py.

The campaign music is Legionnaire (2022 Remaster), Age of Wonder and Song Of The Forge by Scott Buckley, released under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) ([www.scottbuckley.com.au](https://www.scottbuckley.com.au)). The three pieces are joined with short crossfades and their loudness evened out into one file, `packages/assets/frontier-saga.mp3`.

The interface fonts are Cinzel by Natanael Gama and Alegreya Sans by Juan Pablo del Peral (Huerta Tipográfica), both under the [SIL Open Font License 1.1](https://openfontlicense.org). They are served unmodified from `apps/web/fonts`.

These components keep their own licenses. The VaultBorn [license](../LICENSE) covers VaultBorn's own code, art, music and text only and does not limit the rights these licenses give.
