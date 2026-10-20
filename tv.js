// Paso 3: capa de alto nivel sobre mqtt.js, para el firmware VIDAA moderno.
//
// Traduce "sube el volumen" o "abre YouTube" a los topics MQTT que entiende la
// TV, y al revés: lo que la TV publica lo convierte en eventos para la web.
//
// Autenticación del firmware nuevo (ver crypto.js):
//   - certificado de cliente de la app (certs/app_client.pem),
//   - usuario/clave DERIVADOS de la hora y la MAC en cada conexión,
//   - clientId con la forma "<mac>$his$<hash>_vidaacommon_001",
//   - emparejamiento por PIN que devuelve un token de larga duración.
//
// Topics (repos de la comunidad):
//   comandos:  /remoteapp/tv/<service>/<clientId>/actions/<action>
//   datos:     /remoteapp/tv/<service>/<clientId>/data/<fn>
//   respuesta: /remoteapp/mobile/<clientId>/<service>/data/<fn>
//   difusión:  /remoteapp/mobile/broadcast/<...>

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { Client } from './mqtt.js';
import { initialCredentials } from './crypto.js';

const APP_CERT = new URL('./certs/app_client.pem', import.meta.url);
const COMMUNITY_CERT = new URL('./certs/hisense_client.pem', import.meta.url);
const CERT_PATH = existsSync(APP_CERT) ? APP_CERT : COMMUNITY_CERT;
const STATE_PATH = new URL('./tv.json', import.meta.url);

export class HisenseTV extends EventEmitter {
  constructor() {
    super();
    this.state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    this.client = new Client();
    this.ready = false;
  }

  #save() { writeFileSync(STATE_PATH, JSON.stringify(this.state, null, 2) + '\n'); }

  // Bases de topics para el clientId actual.
  #paths() {
    const cid = this.clientId;
    return {
      ui: `/remoteapp/tv/ui_service/${cid}`,
      platform: `/remoteapp/tv/platform_service/${cid}`,
      remote: `/remoteapp/tv/remote_service/${cid}`,
      mobile: `/remoteapp/mobile/${cid}`,
    };
  }

  // Abre la conexión MQTT con mutual TLS y credenciales derivadas.
  // Si ya estamos emparejados, la clave es el token; si no, la derivada (modo
  // emparejamiento). Resuelve cuando llega CONNACK 0.
  connect() {
    const pem = readFileSync(CERT_PATH, 'utf8');
    const { clientId, username, password } = initialCredentials(this.state.mac);
    this.clientId = clientId;           // determinista a partir de la MAC: estable
    this.username = username;           // depende de la hora: cambia por conexión
    const pass = this.state.accessToken || password;

    return new Promise((resolve, reject) => {
      this.client.on('error', (e) => { if (!this.ready) reject(e); else this.emit('error', e); });
      this.client.on('close', () => { this.ready = false; this.emit('close'); });
      this.client.on('message', (topic, payload) => this.#onMessage(topic, payload));
      this.client.on('connack', (code) => {
        if (code !== 0) return reject(new Error(`CONNACK ${code} (no autorizado)`));
        // OJO: este firmware DENIEGA las suscripciones con comodín '#'
        // (SUBACK 128). Hay que suscribirse a cada topic exacto.
        const m = this.#paths().mobile;
        const B = '/remoteapp/mobile/broadcast';
        this.client.subscribe(
          `${m}/ui_service/data/authentication`,
          `${m}/ui_service/data/authenticationcode`,
          `${m}/ui_service/data/authenticationcodeclose`,
          `${m}/ui_service/data/authenticationcodetoast`,
          `${m}/ui_service/data/gettvstate`,
          `${m}/ui_service/data/state`,
          `${m}/ui_service/data/sourcelist`,
          `${m}/ui_service/data/applist`,
          `${m}/platform_service/data/tokenissuance`,
          `${m}/platform_service/data/getvolume`,
          `${B}/ui_service/state`,            // estado al cambiar con el control físico
          `${B}/ui_service/volume`,
          `${B}/platform_service/actions/volumechange`,
        );
        this.ready = true;
        resolve();
      });
      this.client.connect({
        host: this.state.ip, port: this.state.port,
        clientId, username, password: pass, cert: pem, key: pem,
      });
    });
  }

  // Todo lo que la TV publica pasa por aquí. El último segmento del topic dice
  // qué función respondió.
  #onMessage(topic, payload) {
    let data = payload;
    try { data = JSON.parse(payload); } catch { /* algunos vienen en texto plano */ }
    const fn = topic.split('/').pop();
    this.emit('tv', { topic, fn, data });
    if (fn === 'authentication') this.emit('auth-needed');
    else if (fn === 'authenticationcode') this.emit('auth-result', data);
    else if (fn === 'authenticationcodetoast') this.emit('auth-busy');
    else if (fn === 'authenticationcodeclose') this.emit('auth-closed');
    else if (fn === 'tokenissuance') this.#onToken(data);
    else if (fn === 'getvolume' || fn === 'volumechange' || fn === 'volume') this.emit('volume', data);
    else if (fn === 'sourcelist') this.emit('sources', data);
    else if (fn === 'applist') this.emit('apps', data);
    else if (fn === 'state' || fn === 'gettvstate') this.emit('state', data);
  }

  #onToken(data) {
    if (!data || typeof data !== 'object') return;
    this.state.accessToken = String(data.accesstoken ?? '');
    this.state.refreshToken = String(data.refreshtoken ?? '');
    this.state.tokenTime = Date.now();
    this.state.paired = true;
    this.#save();
    this.emit('paired', data);
  }

  #act(base, action, payload = '') {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.client.publish(`${base}/actions/${action}`, body);
  }
  #data(base, fn, payload = '') {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.client.publish(`${base}/data/${fn}`, body);
  }

  // --- Emparejamiento por PIN (firmware moderno) ------------------------
  // Saluda con vidaa_app_connect y pide el estado; una TV no emparejada
  // responde pidiendo el PIN (evento 'auth-needed') y lo muestra en pantalla.
  requestPairing() {
    const p = this.#paths();
    this.#act(p.ui, 'vidaa_app_connect',
      JSON.stringify({ app_version: 2, connect_result: 0, device_type: 'Mobile App' }));
    this.#act(p.ui, 'gettvstate');
  }

  // Envía el PIN. authNum va como NÚMERO, no como texto.
  sendPin(pin) { this.#act(this.#paths().ui, 'authenticationcode', JSON.stringify({ authNum: Number(pin) })); }

  // Tras aceptar el PIN, pide el token de larga duración y cierra el diálogo.
  requestToken() {
    const p = this.#paths();
    this.#data(p.platform, 'gettoken', JSON.stringify({ refreshtoken: '' }));
    this.#act(p.ui, 'authenticationcodeclose');
  }

  // --- Comandos ---------------------------------------------------------
  key(name) { this.#act(this.#paths().remote, 'sendkey', name); }                 // KEY_UP, KEY_OK...
  setVolume(n) { this.#act(this.#paths().platform, 'changevolume', String(Math.max(0, Math.min(100, n | 0)))); }
  getVolume() { this.#act(this.#paths().platform, 'getvolume'); }
  getState() { this.#act(this.#paths().ui, 'gettvstate'); }
  sources() { this.#act(this.#paths().ui, 'sourcelist'); }
  setSource(id) { this.#act(this.#paths().ui, 'changesource', JSON.stringify({ sourceid: String(id) })); }
  apps() { this.#act(this.#paths().ui, 'applist'); }
  launch(app) { this.#act(this.#paths().ui, 'launchapp', JSON.stringify(app)); } // {name, url, urlType, storeType}

  end() { try { this.client.end(); } catch { /* ya cerrado */ } }
}

// Teclas usadas por la página web.
export const KEYS = {
  power: 'KEY_POWER', home: 'KEY_HOME', back: 'KEY_RETURNS', exit: 'KEY_EXIT',
  up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT', ok: 'KEY_OK',
  volup: 'KEY_VOLUMEUP', voldown: 'KEY_VOLUMEDOWN', mute: 'KEY_MUTE',
  menu: 'KEY_MENU', source: 'KEY_SOURCES', info: 'KEY_INFO',
  play: 'KEY_PLAY', pause: 'KEY_PAUSE', stop: 'KEY_STOP',
};
