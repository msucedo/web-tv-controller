// Paso 6: servidor local que une la página web con la TV.
//
// - Sirve public/index.html.
// - Expone endpoints sencillos (/api/...) que la página llama al tocar botones.
// - Mantiene UNA conexión MQTT a la TV y reenvía su estado a la página por SSE
//   (Server-Sent Events): una conexión que queda abierta y por la que el
//   servidor va empujando mensajes al navegador sin que este pregunte.
//
// Accesible desde el iPhone en http://<ip-de-la-mac>:8091

import http from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { HisenseTV, KEYS } from './tv.js';

const PORT = 8091;
const PAGE = new URL('./public/index.html', import.meta.url);

const tv = new HisenseTV();
let connected = false;

async function ensureConnected() {
  if (connected) return true;
  try { await tv.connect(); connected = true; tv.getVolume(); tv.getState(); }
  catch (e) { console.error('No pude conectar a la TV:', e.message); connected = false; }
  return connected;
}
tv.on('close', () => { connected = false; });

// --- SSE: clientes (navegadores) suscritos al estado en vivo ---------------
const clients = new Set();
function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(line);
}
tv.on('volume', (d) => broadcast('volume', d));
tv.on('state', (d) => broadcast('state', d));
tv.on('sources', (d) => broadcast('sources', d));
tv.on('apps', (d) => broadcast('apps', d));

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/index.html') {
    return send(res, 200, await readFile(PAGE), 'text/html; charset=utf-8');
  }

  // Flujo de estado en vivo.
  if (p === '/api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`event: hello\ndata: ${JSON.stringify({ connected })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // Encender: aunque la TV esté apagada (sin MQTT), mandamos Wake-on-LAN.
  if (p === '/api/power') {
    spawn(process.execPath, [new URL('./wol.js', import.meta.url).pathname], { stdio: 'ignore' });
    if (await ensureConnected()) tv.key(KEYS.power); // si está encendida, apaga/enciende
    return send(res, 200, { ok: true });
  }

  // El resto de comandos necesitan la TV encendida y conectada.
  if (p.startsWith('/api/')) {
    if (!(await ensureConnected())) return send(res, 503, { ok: false, error: 'TV no conectada' });
    try {
      if (p === '/api/key') tv.key(KEYS[url.searchParams.get('k')] ?? url.searchParams.get('k'));
      else if (p === '/api/volume') {
        const v = url.searchParams.get('set');
        if (v != null) tv.setVolume(Number(v)); else tv.getVolume();
      } else if (p === '/api/source') {
        const id = url.searchParams.get('id');
        if (id != null) tv.setSource(id); else tv.sources();
      } else if (p === '/api/app') {
        const name = url.searchParams.get('name');
        if (name) tv.launch({ name, url: url.searchParams.get('url') || name, urlType: 37, storeType: 0 });
        else tv.apps();
      } else return send(res, 404, { ok: false });
      return send(res, 200, { ok: true });
    } catch (e) {
      return send(res, 500, { ok: false, error: e.message });
    }
  }

  send(res, 404, 'not found', 'text/plain');
});

server.listen(PORT, () => {
  console.log(`Control en http://localhost:${PORT}  (desde el iPhone: http://${localIp()}:${PORT})`);
  ensureConnected();
});

function localIp() {
  for (const addrs of Object.values(os.networkInterfaces()))
    for (const a of addrs) if (a.family === 'IPv4' && !a.internal) return a.address;
  return 'localhost';
}
