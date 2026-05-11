// Test server that streams forever without finishing. Used to verify preflight
// catches pages that never reach networkidle.
import http from 'node:http';

const port = Number(process.env.PORT) || 0;
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html', 'transfer-encoding': 'chunked' });
  res.write('<html><body><h1>Loading…</h1>');
  // Drip out a byte every 5s so the connection stays alive. networkidle never
  // fires; the page never finishes loading.
  const interval = setInterval(() => {
    try {
      res.write(' ');
    } catch {
      clearInterval(interval);
    }
  }, 5000);
  res.on('close', () => clearInterval(interval));
});
server.listen(port, () => {
  const addr = server.address();
  if (typeof addr === 'object' && addr) {
    // eslint-disable-next-line no-console
    console.log(`http://127.0.0.1:${addr.port}`);
  }
});
