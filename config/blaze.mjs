// The BCH BLAZE 2026 banner that the Mainnet Track asks for at the top of the home page: a link to the presentation, a link
// to the source code, and a CashTokens address for EMBER2026 community-choice tokens. The values are public and live in
// config/blaze.json (a BLAZE_… environment variable replaces a value). Nothing is invented: a link that is not filled in is
// not shown, and the banner says which required item is still missing only in the server log.
import { readFileSync } from 'node:fs';
import { cashAddressToLockingBytecode, lockingBytecodeToCashAddress } from '@bitauth/libauth';

const link = (value) => {
  try {
    const url = new URL(String(value ?? '').trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
};
// EMBER2026 is a Mainnet token, so the address is always a Mainnet one and is shown in its token-aware form.
function tokenAddress(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text.startsWith('bitcoincash:')) return '';
  const decoded = cashAddressToLockingBytecode(text);
  if (typeof decoded === 'string' || decoded.prefix !== 'bitcoincash') return '';
  const encoded = lockingBytecodeToCashAddress({ prefix: 'bitcoincash', bytecode: decoded.bytecode, tokenSupport: true });
  return typeof encoded === 'string' ? '' : encoded.address;
}

export function blazeBanner({ developmentAddress, environment = process.env, file = new URL('./blaze.json', import.meta.url) } = {}) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* No file: only the environment is used. */ }
  const value = (name, key) => environment['BLAZE_' + name] ?? saved[key];
  if (/^(0|false|off)$/i.test(environment.BLAZE_BANNER ?? '')) return { enabled: false };
  const own = tokenAddress(value('EMBER_ADDRESS', 'emberAddress'));
  // Without an address of its own, the banner shows the token-aware form of the developer address: same wallet key.
  const derived = own ? '' : tokenAddress(developmentAddress);
  const banner = { enabled: true, event: 'BCH BLAZE 2026', presentation: link(value('PRESENTATION_URL', 'presentation')),
    repository: link(value('REPOSITORY_URL', 'repository')), emberAddress: own || derived, emberFromDeveloperAddress: Boolean(derived),
    oldRepository: link(value('OLD_REPOSITORY_URL', 'oldRepository')), earlierDemo: link(value('EARLIER_DEMO_URL', 'earlierDemo')) };
  banner.missing = [!banner.presentation && 'presentation link', !banner.repository && 'repository link', !banner.emberAddress && 'EMBER2026 CashTokens address'].filter(Boolean);
  return banner;
}
