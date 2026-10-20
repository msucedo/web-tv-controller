// Paso 5: encender la TV con Wake-on-LAN.
//
// Una TV apagada no tiene IP activa, así que no le podemos hablar por MQTT.
// Wake-on-LAN manda un "magic packet": un paquete UDP con 6 bytes 0xFF seguidos
// de la MAC repetida 16 veces. La tarjeta de red de la TV lo reconoce aunque el
// resto esté dormido y la enciende.
//
// Requiere activar en la TV la opción de encendido por red (suele estar en
// Ajustes → Sistema → algo como "Encendido rápido" / "Wake on LAN/WiFi").

import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';

const tv = JSON.parse(readFileSync(new URL('./tv.json', import.meta.url), 'utf8'));
if (!tv.mac) { console.error('No tengo la MAC de la TV en tv.json'); process.exit(1); }

const mac = Buffer.from(tv.mac.split(':').map((h) => parseInt(h, 16)));
const magic = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(mac)]);

const sock = dgram.createSocket('udp4');
sock.bind(() => {
  sock.setBroadcast(true);
  // Lo mandamos a la difusión de la red (255) y a la IP de la TV, por si acaso.
  const targets = ['255.255.255.255', tv.ip];
  let pending = targets.length;
  for (const addr of targets) {
    sock.send(magic, 0, magic.length, 9, addr, () => { if (--pending === 0) { sock.close(); } });
  }
  console.log(`Magic packet enviado a ${tv.mac}. Si la TV tiene Wake-on-LAN activado, debería encender.`);
});
