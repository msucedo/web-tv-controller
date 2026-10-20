// Paso 2 (prueba): ¿la TV acepta nuestra conexión MQTT?
//
// Usa las credenciales "clásicas" que trae la app RemoteNOW. Imprime cada
// paquete en hex para que veas el protocolo tal cual viaja por el cable.

import { readFileSync } from 'node:fs';
import { Client, CONNACK_CODES, hex } from './mqtt.js';

const tv = JSON.parse(readFileSync('tv.json', 'utf8'));
const creds = {
  clientId: 'hisense-remote',
  username: 'hisenseservice',
  password: 'multimqttservice',
};

console.log(`Conectando a ${tv.ip}:${tv.port} como "${creds.username}"...`);
const client = new Client().connect({ host: tv.ip, port: tv.port, ...creds });

client.on('tls', (proto, cipher) => console.log(`TLS listo: ${proto} ${cipher}`));
client.on('sent', (b) => console.log(`→ ${hex(b)}`));
client.on('packet', (p) => console.log(`← ${p.name}: ${hex(p.raw)}`));

client.on('connack', (code) => {
  console.log(`CONNACK ${code}: ${CONNACK_CODES[code] ?? 'desconocido'}`);
  if (code !== 0) return;
  // Si nos aceptó, escuchamos unos segundos todo lo que la TV publique.
  client.subscribe('/remoteapp/mobile/#');
  client.on('message', (topic, payload) => console.log(`  ${topic}\n    ${payload}`));
  setTimeout(() => client.end(), 8000);
});

client.on('error', (e) => console.log(`Error: ${e.code ?? ''} ${e.message}`));
client.on('close', () => console.log('Conexión cerrada'));
