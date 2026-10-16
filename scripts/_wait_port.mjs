import net from 'node:net';
const port = Number(process.argv[2]);
const end = Date.now() + Number(process.argv[3] ?? 240) * 1000;
const tryOnce = () =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
  });
while (Date.now() < end) {
  if (await tryOnce()) {
    console.log('port open');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 3000));
}
console.log('port still closed');
process.exit(1);
