// node --test imerg-pendientes/test/prender.test.mjs   · sin red: `gh` es uno falso que anota lo que le piden.
// El paso 5 de LISTO-232 (prender) como script: prende SÓLO con el imerg-backfill.yml de hn-agro@main leído entero y
// sin repository_dispatch. 3.ª vuelta, P1 de Codex (n3-232-v2-1411): el comando de la 2.ª prendía si gh api fallaba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(RAIZ, 'prender.sh');
const BASH = process.env.IMERG_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const SALTEAR = process.platform === 'win32' && !fs.existsSync(BASH) && 'sin bash (Git Bash)';

const GH_FALSO = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
case "$1" in
  api) case "$FAKE_GH_API" in
         falla)  echo 'HTTP 502: Bad Gateway' >&2; exit 1 ;;
         vacio)  exit 0 ;;
         basura) echo '@@@ esto no es JSON @@@'; exit 0 ;;
         noesta) echo '{"message":"Not Found","documentation_url":"https://docs.github.com/rest","status":"404"}'; exit 0 ;;
         ok)     cat "$FAKE_GH_B64"; exit 0 ;;
       esac ;;
  variable) [ "\${FAKE_GH_VAR:-ok}" = ok ] && exit 0; echo 'HTTP 403' >&2; exit 1 ;;
esac
exit 3
`;

/** El YAML como lo da la API de contenidos: base64 cortado cada 60 caracteres. */
const b64 = (yml) => Buffer.from(yml, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n') + '\n';
const RUTA = '.github/workflows/imerg-backfill.yml';
const shaBlob = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
/** 4.ª vuelta: la respuesta ENTERA de la API de contenidos (prender.sh ya no pide sólo .content). `de` = el archivo del
 *  que salen size y sha (para simular un contenido truncado o alterado); `mas` = campos que se pisan. */
function respuesta(yml, { de = yml, mas = {} } = {}) {
  const real = Buffer.from(de, 'utf8');
  return JSON.stringify({ name: 'imerg-backfill.yml', path: RUTA, sha: shaBlob(real), size: real.length, type: 'file',
    encoding: 'base64', content: b64(yml), ...mas });
}

function correr({ api, yml = '', variable = 'ok', comando = null, crudo = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prender-'));
  try {
    fs.writeFileSync(path.join(dir, 'gh'), GH_FALSO, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'contenido.b64'), crudo ?? (comando ? b64(yml) : respuesta(yml)));
    const log = path.join(dir, 'log.txt'); fs.writeFileSync(log, '');
    const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH, FAKE_GH_LOG: log, FAKE_GH_API: api,
      FAKE_GH_B64: path.join(dir, 'contenido.b64'), FAKE_GH_VAR: variable };
    const r = spawnSync(BASH, comando ? ['-c', comando] : [SCRIPT], { encoding: 'utf8', env });
    return { codigo: r.status, salida: (r.stdout || '') + (r.stderr || ''), pedidos: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const PRENDE = (p) => p.some((l) => /^variable set IMERG_PENDIENTES_ON\b/.test(l));

const SIN_DISPATCH = `# HN AGRO · relleno IMERG (antes se disparaba por repository_dispatch; ver 232)
name: imerg-backfill
on:
  workflow_dispatch:
    inputs:
      celdas: { type: string }
jobs:
  rellenar:
    runs-on: ubuntu-latest
    steps: [{ run: echo hola }]
`;
const CON_DISPATCH = SIN_DISPATCH.replace('on:\n  workflow_dispatch:', 'on:\n  repository_dispatch:\n    types: [imerg-backfill]\n  workflow_dispatch:');

test('prender · la reproducción de Codex: el comando de la 2.ª vuelta PRENDÍA si gh api fallaba (grep -c de nada = 0)', { skip: SALTEAR }, () => {
  const viejo = `set -o pipefail
N=$(gh api repos/hernan1015/hn-agro/contents/.github/workflows/imerg-backfill.yml --jq .content | base64 -d \\
     | grep -cE '^[[:space:]]*repository_dispatch:')
[ "$N" = 0 ] && gh variable set IMERG_PENDIENTES_ON -b si -R hernan1015/hn-colectores && echo "PRENDIDO" \\
  || echo "NO PRENDER: hn-agro sigue con repository_dispatch (N=$N)"`;
  const r = correr({ api: 'falla', comando: viejo });
  assert.match(r.salida, /PRENDIDO/, 'deja constancia del bloqueo: el comando viejo prende sin haber leído nada');
});

test('prender · si gh api falla, devuelve vacío o algo que no decodifica: NO PRENDER y la variable no se toca', { skip: SALTEAR }, () => {
  for (const api of ['falla', 'vacio', 'basura', 'noesta']) {
    const r = correr({ api });
    assert.equal(r.codigo, 1, api);
    assert.match(r.salida, /NO PRENDER/, api);
    assert.doesNotMatch(r.salida, /PRENDIDO/, api);
    assert.ok(!PRENDE(r.pedidos), `${api}: no llama a gh variable set`);
  }
});

test('prender · lee el workflow de main (ref=main) y con repository_dispatch, en bloque o en lista, NO PRENDE', { skip: SALTEAR }, () => {
  for (const [que, yml] of [
    ['bloque', CON_DISPATCH],
    ['lista', SIN_DISPATCH.replace('on:\n  workflow_dispatch:\n    inputs:\n      celdas: { type: string }', 'on: [workflow_dispatch, repository_dispatch]')],
    ['mapa en línea', SIN_DISPATCH.replace('on:\n  workflow_dispatch:\n    inputs:\n      celdas: { type: string }', 'on: { workflow_dispatch: {}, repository_dispatch: { types: [imerg-backfill] } }')],
  ]) {
    const r = correr({ api: 'ok', yml });
    assert.equal(r.codigo, 1, que); assert.match(r.salida, /sigue con repository_dispatch/, que);
    assert.ok(!PRENDE(r.pedidos), que);
    assert.ok(r.pedidos.some((l) => /^api repos\/hernan1015\/hn-agro\/contents\/\.github\/workflows\/imerg-backfill\.yml\?ref=main( |$)/.test(l)), r.pedidos.join('\n'));
  }
});

test('prender · un archivo que no es el workflow (sin workflow_dispatch, o vacío decodificado) NO PRENDE', { skip: SALTEAR }, () => {
  for (const yml of ['{"message":"Not Found"}', '# repository_dispatch sólo en un comentario\n', '\n']) {
    const r = correr({ api: 'ok', yml });
    assert.equal(r.codigo, 1, JSON.stringify(yml)); assert.ok(!PRENDE(r.pedidos), JSON.stringify(yml));
  }
});

test('prender · con el paso 4 hecho (sin repository_dispatch, aunque lo nombre un comentario) PRENDE; si gh variable set falla, lo dice', { skip: SALTEAR }, () => {
  const r = correr({ api: 'ok', yml: SIN_DISPATCH });
  assert.equal(r.codigo, 0, r.salida); assert.match(r.salida, /^PRENDIDO$/m);
  assert.ok(r.pedidos.includes('variable set IMERG_PENDIENTES_ON -b si -R hernan1015/hn-colectores'), r.pedidos.join('\n'));
  const f = correr({ api: 'ok', yml: SIN_DISPATCH, variable: 'falla' });
  assert.equal(f.codigo, 1); assert.match(f.salida, /NO PRENDER: gh variable set falló/); assert.doesNotMatch(f.salida, /PRENDIDO/);
});

// ── 4.ª vuelta (P1 de Codex, n3-232-v3-1511): el YAML parseado de verdad y el archivo leído entero ──
const CODEX_FLUJO = `name: imerg-backfill
on: {workflow_dispatch: {inputs: {x: {description: "#", type: string}}}, repository_dispatch: {types: [imerg-backfill]}}
jobs:
  rellenar:
    runs-on: ubuntu-latest
    steps: [{run: echo hola}]
`;
const NO_PRENDE = (r, que, motivo) => {
  assert.equal(r.codigo, 1, `${que}: ${r.salida}`);
  assert.match(r.salida, /NO PRENDER/, que); assert.doesNotMatch(r.salida, /PRENDIDO/, que);
  assert.ok(!PRENDE(r.pedidos), `${que}: no llama a gh variable set`);
  if (motivo) assert.match(r.salida, motivo, `${que}: ${r.salida}`);
};
const SI_PRENDE = (r, que) => {
  assert.equal(r.codigo, 0, `${que}: ${r.salida}`); assert.match(r.salida, /^PRENDIDO$/m, que);
  assert.ok(PRENDE(r.pedidos), que);
};

test('prender 4.ª · el contraejemplo de Codex: un "#" dentro de una cadena no esconde el repository_dispatch en flujo', { skip: SALTEAR }, () => {
  NO_PRENDE(correr({ api: 'ok', yml: CODEX_FLUJO }), 'flujo con "#"', /sigue con repository_dispatch/);
  // y la misma línea con un comentario de verdad al final, y con «#» en una cadena de un bloque
  NO_PRENDE(correr({ api: 'ok', yml: CODEX_FLUJO.replace('[imerg-backfill]}}', '[imerg-backfill]}}   # comentario') }), 'flujo + comentario', /sigue con repository_dispatch/);
  NO_PRENDE(correr({ api: 'ok', yml: CON_DISPATCH.replace('celdas: { type: string }', "celdas: { type: string, description: 'a # b' }") }), 'bloque con "#"', /sigue con repository_dispatch/);
});

test('prender 4.ª · on: [workflow_dispatch, repository_dispatch] (lista en flujo y en bloque, escalar, comillas) NO PRENDE', { skip: SALTEAR }, () => {
  const base = 'name: imerg-backfill\nON\njobs:\n  rellenar:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo hola }]\n';
  NO_PRENDE(correr({ api: 'ok', yml: base.replace('ON', 'on: [workflow_dispatch, repository_dispatch]') }), 'lista flujo', /sigue con repository_dispatch/);
  NO_PRENDE(correr({ api: 'ok', yml: base.replace('ON', 'on:\n  - workflow_dispatch\n  - "repository_dispatch"') }), 'lista bloque', /sigue con repository_dispatch/);
  NO_PRENDE(correr({ api: 'ok', yml: base.replace('ON', 'on: repository_dispatch') }), 'escalar', /sigue con repository_dispatch/);
  NO_PRENDE(correr({ api: 'ok', yml: base.replace('ON', '"on": {workflow_dispatch: {}, "repository_dispatch": {}}') }), 'claves entre comillas', /sigue con repository_dispatch/);
  NO_PRENDE(correr({ api: 'ok', yml: base.replace('ON', 'on: [push]') }), 'sin workflow_dispatch', /no tiene workflow_dispatch/);
  // sin repository_dispatch y con un "#" en una cadena: prende (el parser no es más estricto que la regla)
  SI_PRENDE(correr({ api: 'ok', yml: base.replace('ON', 'on: {workflow_dispatch: {inputs: {x: {description: "#", type: string}}}}') }), 'flujo sin dispatch');
  SI_PRENDE(correr({ api: 'ok', yml: base.replace('ON', 'on: [workflow_dispatch]') }), 'lista sin dispatch');
});

test('prender 4.ª · un YAML inválido (no parsea, clave repetida, dos documentos, etiqueta rara) NO PRENDE', { skip: SALTEAR }, () => {
  for (const [que, yml] of [
    ['flujo sin cerrar', SIN_DISPATCH.replace('on:\n  workflow_dispatch:', 'on: [workflow_dispatch')],
    ['on repetido', SIN_DISPATCH + 'on:\n  repository_dispatch:\n'],
    ['dos documentos', SIN_DISPATCH + '---\non: [repository_dispatch]\n'],
    ['etiqueta desconocida', SIN_DISPATCH.replace('name: imerg-backfill', 'name: !raro imerg-backfill')],
    ['sangría rota', SIN_DISPATCH.replace('    inputs:', '   inputs:\n  - x')],
  ]) NO_PRENDE(correr({ api: 'ok', yml }), que, /YAML|documento/);
});

const ON_BLOQUE = /on:\n  workflow_dispatch:\n    inputs:\n      celdas: \{ type: string \}/;
test('prender 4.ª · anclas, alias y merge se resuelven: el repository_dispatch que entra por un alias NO PRENDE', { skip: SALTEAR }, () => {
  const ancla = 'x-ev: &ev\n  workflow_dispatch: {}\n  repository_dispatch: { types: [imerg-backfill] }\n';
  NO_PRENDE(correr({ api: 'ok', yml: ancla + SIN_DISPATCH.replace(ON_BLOQUE, 'on: *ev') }), 'on: *ev', /sigue con repository_dispatch/);
  NO_PRENDE(correr({ api: 'ok', yml: ancla + SIN_DISPATCH.replace('on:\n  workflow_dispatch:', 'on:\n  <<: *ev\n  workflow_dispatch:') }), 'merge <<', /sigue con repository_dispatch/);
  NO_PRENDE(correr({ api: 'ok', yml: 'x: &rd repository_dispatch\n' + SIN_DISPATCH.replace(ON_BLOQUE, 'on: [workflow_dispatch, *rd]') }), 'lista con alias', /sigue con repository_dispatch/);
  // un ancla inofensiva se resuelve y prende
  SI_PRENDE(correr({ api: 'ok', yml: 'x-in: &in { celdas: { type: string } }\n' + SIN_DISPATCH.replace('    inputs:\n      celdas: { type: string }', '    inputs: *in') }), 'ancla inofensiva');
});

test('prender 4.ª · el archivo tiene que llegar ENTERO: truncado, alterado, otro archivo o sin jobs NO PRENDE', { skip: SALTEAR }, () => {
  const corto = 'name: imerg-backfill\non:\n  workflow_dispatch:\n';
  NO_PRENDE(correr({ api: 'ok', crudo: respuesta(corto, { de: CON_DISPATCH }) }), 'truncado (size/sha del entero)', /incompleto/);
  NO_PRENDE(correr({ api: 'ok', yml: corto }), 'la respuesta de Codex: sólo name+on (con su sha)', /sin jobs/);
  NO_PRENDE(correr({ api: 'ok', crudo: respuesta(SIN_DISPATCH, { de: SIN_DISPATCH.replace('hola', 'chau') }) }), 'mismo tamaño, otro sha', /sha/);
  NO_PRENDE(correr({ api: 'ok', yml: SIN_DISPATCH.replace('name: imerg-backfill', 'name: otro') }), 'otro name', /no es el imerg-backfill/);
  for (const [que, mas] of [['otro path', { path: '.github/workflows/otro.yml' }], ['carpeta', { type: 'dir' }],
    ['sin encoding', { encoding: 'none' }], ['sin sha', { sha: undefined }], ['sin size', { size: undefined }], ['content vacío', { content: '' }],
    ['size que no es el del contenido (sha bien)', { size: Buffer.byteLength(SIN_DISPATCH) + 5 }]]) {
    NO_PRENDE(correr({ api: 'ok', crudo: respuesta(SIN_DISPATCH, { mas }) }), que);
  }
  NO_PRENDE(correr({ api: 'ok', crudo: respuesta(SIN_DISPATCH).replace('"content":"', '"content":"@@') }), 'base64 con basura');
  NO_PRENDE(correr({ api: 'ok', crudo: '[' + respuesta(SIN_DISPATCH) + ']' }), 'una lista (carpeta)');
});

test('prender 4.ª · el imerg-backfill.yml real de hn-agro: tal cual NO PRENDE; sin el bloque repository_dispatch (paso 4) PRENDE', { skip: SALTEAR }, () => {
  const REAL = [
    '# F1 · IMERG-Final backfill lazy por celda 0.1° → Supabase (imerg_pp_diario)',
    '# Corre en GitHub Actions (sin el cap de 10s de Netlify). Manual (workflow_dispatch) o disparado',
    '# por la función lazy de Netlify (repository_dispatch: imerg-backfill).',
    'name: imerg-backfill',
    '',
    'on:',
    '  workflow_dispatch:',
    '    inputs:',
    '      cells:',
    "        description: 'Puntos lat,lon separados por ;  (ej: -37.605,-64.258;-26.85,-65.2)'",
    '        required: true',
    '      start:',
    "        description: 'Inicio ISO (IMERG-Final desde 2000-06-01)'",
    '        required: false',
    "        default: '2000-06-01T00:00:00'",
    '  repository_dispatch:',
    '    types: [imerg-backfill]',
    '',
    'concurrency: imerg-backfill           # evita corridas solapadas sobre las mismas celdas',
    '',
    'jobs:',
    '  backfill:',
    '    runs-on: ubuntu-latest',
    '    steps: [{ run: echo hola }]',
    '',
  ].join('\n');
  NO_PRENDE(correr({ api: 'ok', yml: REAL }), 'real', /sigue con repository_dispatch/);
  SI_PRENDE(correr({ api: 'ok', yml: REAL.replace('  repository_dispatch:\n    types: [imerg-backfill]\n', '') }), 'real tras el paso 4');
});
