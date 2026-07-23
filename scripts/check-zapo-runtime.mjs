const runtimeModules = [
  'zapo-js',
  '@zapo-js/store-sqlite',
  '@zapo-js/voip',
  '@roamhq/wrtc',
  'libmlow-wasm',
  'ws',
  'socks-proxy-agent',
];

await Promise.all(runtimeModules.map(specifier => import(specifier)));

console.log(`Zapo runtime imports OK (${runtimeModules.join(', ')})`);
