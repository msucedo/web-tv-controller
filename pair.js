// Paso 4: emparejar una vez con la TV (firmware moderno).
//
// Conecta, saluda y pide el estado; la TV muestra un PIN de 4 dígitos (expira en
// ~30 s). Lo tecleas, la TV lo valida y nos entrega un token de larga duración
// que queda guardado en tv.json. A partir de ahí, server.js conecta solo.
//
// IMPORTANTE: cierra la app oficial RemoteNOW/VIDAA antes: la TV admite un solo
// mando a la vez; si la app está abierta, en vez del PIN manda "ocupado".

import { createInterface } from 'node:readline/promises';
import { HisenseTV } from './tv.js';

const tv = new HisenseTV();
const rl = createInterface({ input: process.stdin, output: process.stdout });
const finish = (code) => { tv.end(); rl.close(); process.exit(code); };

tv.on('auth-busy', () => {
  console.log('\nLa TV dice "ocupado": cierra la app RemoteNOW/VIDAA y vuelve a intentar.');
  finish(1);
});
tv.on('paired', (t) => {
  const days = t.accesstoken_duration_day ?? '?';
  console.log(`\n¡Emparejado! Token guardado en tv.json (válido ~${days} días).`);
  console.log('Ya puedes correr: node server.js');
  finish(0);
});

console.log('Conectando a la TV...');
await tv.connect();
console.log('Conectado (CONNACK 0). Pidiendo el código...');

let asked = false;
async function askPin() {
  if (asked) return;
  asked = true;
  const pin = (await rl.question('Escribe el PIN que ves en la TV: ')).trim();
  tv.sendPin(pin);
}

tv.on('auth-needed', () => { console.log('La TV está mostrando un PIN de 4 dígitos.'); askPin(); });
tv.on('auth-result', (r) => {
  if (r && r.result === 1) { console.log('PIN aceptado. Pidiendo token...'); tv.requestToken(); }
  else { console.log(`\nPIN rechazado o expirado (${JSON.stringify(r)}). Corre de nuevo node pair.js.`); finish(1); }
});

tv.requestPairing();
// Por si la TV no empuja 'authentication' pero igual muestra el PIN: preguntamos.
setTimeout(askPin, 3000);
setTimeout(() => { console.log('\nSin respuesta de la TV (¿quedó algún mando conectado?).'); finish(1); }, 60000);
