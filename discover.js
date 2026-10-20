// Paso 1: encontrar la TV en la red.
//
// Las TVs VIDAA no siempre contestan SSDP (la tuya no lo hizo), pero siempre
// abren el puerto 36669: ahí vive el broker MQTT que usa la app RemoteNOW.
// Así que hacemos lo mismo que hace la app: probar cada IP de la subred y ver
// quién acepta conexiones en ese puerto.

import net from 'node:net';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const MQTT_PORT = 36669;
const TIMEOUT_MS = 500;
const PARALLEL = 64;

// Busca la interfaz IPv4 real de la Mac (en0 normalmente) y saca su /24.
function localSubnet() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) {
        const base = a.address.split('.').slice(0, 3).join('.');
        return { name, self: a.address, base };
      }
    }
  }
  throw new Error('No encontré una interfaz de red IPv4');
}

// Intenta abrir una conexión TCP. Si conecta, el puerto está abierto.
function probe(ip, port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    const done = (open) => { sock.destroy(); resolve(open); };
    sock.setTimeout(TIMEOUT_MS, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Después de hablar con una IP, el sistema ya conoce su MAC (tabla ARP).
// La necesitamos para Wake-on-LAN, que despierta la TV por su MAC, no su IP.
function macFor(ip) {
  try {
    const out = execFileSync('arp', ['-n', ip], { encoding: 'utf8' });
    const m = out.match(/at ([0-9a-f:]+)/i);
    // arp en macOS quita los ceros a la izquierda ("b" en vez de "0b").
    return m ? m[1].split(':').map((x) => x.padStart(2, '0')).join(':') : null;
  } catch {
    return null;
  }
}

async function main() {
  const subnet = localSubnet();
  console.log(`Mac en ${subnet.self} (${subnet.name}); escaneando ${subnet.base}.1-254 puerto ${MQTT_PORT}...`);

  const ips = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet.base}.${i}`;
    if (ip !== subnet.self) ips.push(ip);
  }

  // Probamos en tandas para no abrir 254 sockets de golpe.
  const found = [];
  for (let i = 0; i < ips.length; i += PARALLEL) {
    const batch = ips.slice(i, i + PARALLEL);
    const results = await Promise.all(batch.map((ip) => probe(ip, MQTT_PORT)));
    batch.forEach((ip, j) => results[j] && found.push(ip));
  }

  if (found.length === 0) {
    console.log('No encontré ninguna TV VIDAA. ¿Está prendida y en la misma red?');
    process.exit(1);
  }

  const tvs = found.map((ip) => ({ ip, mac: macFor(ip), port: MQTT_PORT }));
  for (const tv of tvs) console.log(`TV VIDAA → ${tv.ip}  MAC ${tv.mac ?? '?'}`);

  writeFileSync('tv.json', JSON.stringify(tvs[0], null, 2) + '\n');
  console.log('Guardado en tv.json');
}

main();
