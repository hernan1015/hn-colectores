// HN AGRO · imerg-pendientes · el chequeo de prender.sh (LISTO-232, paso 5), en node y con un parser de YAML de verdad.
// 4.ª vuelta (P1 de Codex, n3-232-v3-1511): la 3.ª limpiaba comentarios con `sed 's/#.*$//'` y buscaba texto. Un `#`
// adentro de una cadena YAML se comía el resto de la línea, y con él un repository_dispatch escrito en forma de flujo
// ({workflow_dispatch: …"#"…, repository_dispatch: …}): prendía. Y un archivo truncado que sólo dijera
// «on: workflow_dispatch:» también prendía. Ahora:
//   1. la respuesta ENTERA de la API de contenidos (JSON): type=file, encoding=base64, path = el workflow;
//   2. el base64 canónico, y lo decodificado tiene que dar `size` bytes y el sha de blob de git que da la API (si falta
//      un pedazo, no coincide): así se sabe que se leyó el archivo entero;
//   3. UTF-8 válido; UN documento YAML (1.2, claves únicas, alias resueltos con tope, merge `<<` resuelto) sin errores
//      ni advertencias;
//   4. se miran las claves de `on` del documento parseado (escalar, lista o mapa, en bloque o en flujo), no el texto:
//      tiene que estar workflow_dispatch y no repository_dispatch; y name = imerg-backfill con jobs no vacío.
// Cualquier otra cosa → falla con motivo. Si el parseo falla, NO PRENDER.
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseAllDocuments, isAlias, isMap, isScalar } from 'yaml';

export const RUTA = '.github/workflows/imerg-backfill.yml';
export const OK = 'SIN_REPOSITORY_DISPATCH';

class NoPrender extends Error {}
const no = (m) => { throw new NoPrender(m); };
const esObjeto = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** sha de blob de git (el `sha` que devuelve la API de contenidos). */
export const shaBlob = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

/** Respuesta de la API (texto JSON) → el YAML, sólo si se leyó entero. */
export function contenido(respuesta) {
  let j;
  try { j = JSON.parse(respuesta); } catch { no('la respuesta de gh api no es JSON'); }
  if (!esObjeto(j)) no('la respuesta de gh api no es un objeto (¿una carpeta?)');
  if (j.type !== 'file') no(`la respuesta no es un archivo (type=${JSON.stringify(j.type)})`);
  if (j.path !== RUTA) no(`la respuesta es de otro archivo (path=${JSON.stringify(j.path)})`);
  if (j.encoding !== 'base64') no(`la respuesta no viene en base64 (encoding=${JSON.stringify(j.encoding)})`);
  if (typeof j.content !== 'string' || !j.content.length) no('la respuesta no trae contenido');
  if (!Number.isInteger(j.size) || j.size <= 0) no('la respuesta no trae el tamaño');
  if (typeof j.sha !== 'string' || !/^[0-9a-f]{40}$/.test(j.sha)) no('la respuesta no trae el sha');
  const b64 = j.content.replace(/\n/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4) no('el contenido no es base64');
  const buf = Buffer.from(b64, 'base64');
  if (buf.toString('base64') !== b64) no('el contenido no es base64 canónico');
  if (buf.length !== j.size) no(`el contenido está incompleto (${buf.length} de ${j.size} bytes)`);
  if (shaBlob(buf) !== j.sha) no('el contenido no coincide con el sha del archivo (incompleto o alterado)');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { no('el contenido no es UTF-8'); }
}

/** El YAML del workflow → los eventos. Falla con motivo ante cualquier cosa que no sea un workflow claro. */
export function eventos(yml) {
  const docs = parseAllDocuments(yml, { version: '1.2', merge: true, uniqueKeys: true, strict: true, prettyErrors: false });
  if (!Array.isArray(docs) || docs.length !== 1) no(`el workflow no es UN documento YAML (${Array.isArray(docs) ? docs.length : '?'})`);
  const [doc] = docs;
  if (doc.errors.length) no(`el YAML no parsea: ${doc.errors[0].message.split('\n')[0]}`);
  if (doc.warnings.length) no(`el YAML tiene advertencias: ${doc.warnings[0].message.split('\n')[0]}`);
  const raiz = doc.contents;
  if (!isMap(raiz)) no('el workflow no es un mapa');
  for (const it of raiz.items) if (!isScalar(it.key) || typeof it.key.value !== 'string') no('el workflow tiene una clave que no es una cadena');
  let js;
  try { js = doc.toJS({ maxAliasCount: 50 }); } catch (e) { no(`el YAML no se resuelve: ${String(e.message).split('\n')[0]}`); }
  if (!esObjeto(js)) no('el workflow no es un mapa');
  if (js.name !== 'imerg-backfill') no(`no es el imerg-backfill.yml (name=${JSON.stringify(js.name)})`);
  if (!esObjeto(js.jobs) || !Object.keys(js.jobs).length) no('no es el imerg-backfill.yml (sin jobs)');
  if (!Object.prototype.hasOwnProperty.call(js, 'on')) no('el workflow no tiene `on`');
  // Lo que vale es `on` ya resuelto (alias, anclas y merge `<<`), en cualquiera de sus formas.
  let nodoOn = raiz.items.find((it) => it.key.value === 'on').value;
  if (isAlias(nodoOn)) nodoOn = nodoOn.resolve(doc);
  if (isMap(nodoOn)) {
    // la clave de merge `<<` (un símbolo en el AST) ya quedó resuelta en js.on; cualquier otra tiene que ser cadena
    for (const it of nodoOn.items) {
      const esMerge = isScalar(it.key) && typeof it.key.value === 'symbol' && it.key.value.description === '<<';
      if (!esMerge && (!isScalar(it.key) || typeof it.key.value !== 'string')) no('`on` tiene una clave que no es una cadena');
    }
  }
  const on = js.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) {
    if (!on.length || on.some((e) => typeof e !== 'string')) no('`on` tiene un evento que no es una cadena');
    return on;
  }
  if (esObjeto(on) && Object.keys(on).length) return Object.keys(on);
  no('`on` no es ni evento, ni lista, ni mapa');
}

/** Todo el chequeo: devuelve OK o lanza NoPrender con el motivo. */
export function chequear(respuesta) {
  const ev = eventos(contenido(respuesta)).map((e) => e.trim().toLowerCase());
  if (ev.includes('repository_dispatch')) no('hn-agro sigue con repository_dispatch (hacer antes el paso 4)');
  if (!ev.includes('workflow_dispatch')) no('no parece el imerg-backfill.yml (no tiene workflow_dispatch)');
  return OK;
}

// CLI: la respuesta de `gh api` por stdin; imprime OK y sale 0, o el motivo y sale 1.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const partes = [];
  process.stdin.on('data', (d) => partes.push(d));
  process.stdin.on('end', () => {
    try { console.log(chequear(Buffer.concat(partes).toString('utf8'))); process.exit(0); }
    catch (e) { console.log(e instanceof NoPrender ? e.message : `el chequeo falló: ${e && e.message}`); process.exit(1); }
  });
}
