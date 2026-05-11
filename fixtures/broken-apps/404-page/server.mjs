// Test server that always returns HTTP 404. Used to verify preflight catches
// non-2xx responses before the Explorer is spun up.
import http from 'node:http';

const port = Number(process.env.PORT) || 0;
const server = http.createServer((_req, res) => {
  res.writeHead(404, { 'content-type': 'text/html' });
  res.end('<html><body><h1>Not Found</h1></body></html>');
});
server.listen(port, () => {
  const addr = server.address();
  if (typeof addr === 'object' && addr) {
    // eslint-disable-next-line no-console
    console.log(`http://127.0.0.1:${addr.port}`);
  }
});
