// node --test imerg-pendientes/test/prender.test.mjs   · sin red: `gh` es uno falso que anota lo que le piden.
// El paso 5 de LISTO-232 (prender) como script: prende SÓLO con el imerg-backfill.yml de hn-agro@main leído entero y
// sin repository_dispatch. 3.ª vuelta, P1 de Codex (n3-232-v2-1411): el comando de la 2.ª prendía si gh api fallaba.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
         basura) echo '@@@ esto no es base64 @@@'; exit 0 ;;
         ok)     cat "$FAKE_GH_B64"; exit 0 ;;
       esac ;;
  variable) [ "\${FAKE_GH_VAR:-ok}" = ok ] && exit 0; echo 'HTTP 403' >&2; exit 1 ;;
esac
exit 3
`;

/** El YAML como lo da la API de contenidos: base64 cortado cada 60 caracteres. */
const b64 = (yml) => Buffer.from(yml, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n') + '\n';

function correr({ api, yml = '', variable = 'ok', comando = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prender-'));
  try {
    fs.writeFileSync(path.join(dir, 'gh'), GH_FALSO, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'contenido.b64'), b64(yml));
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
  for (const api of ['falla', 'vacio', 'basura']) {
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
    assert.ok(r.pedidos.some((l) => l.startsWith('api repos/hernan1015/hn-agro/contents/.github/workflows/imerg-backfill.yml?ref=main ')), r.pedidos.join('\n'));
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
