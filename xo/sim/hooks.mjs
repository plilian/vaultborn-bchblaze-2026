const fake = new URL('./fake-electrum.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === '@electrum-cash/application') return { url: fake, shortCircuit: true };
  if (specifier === '@electrum-cash/protocol' && /@xo-cash\/engine\//.test(context.parentURL ?? '')) return { url: fake, shortCircuit: true };
  return next(specifier, context);
}
