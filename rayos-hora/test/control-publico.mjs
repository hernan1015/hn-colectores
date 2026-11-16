// [_v1815] Control negativo CONTADO de test/publico.test.mjs: rompe una cosa por vez en una copia de lib/ y exige rojo.
// Correr: node test/control-publico.mjs (dentro de rayos-hora/).
// [2.ª vuelta] node test/control-publico.mjs --contra <ref>: corre ESTE test contra la lib/ de esa punta (git show) y exige
// rojo, contando cuántos tests caen (la punta vieja 165e99b tiene que caer en los de la 2.ª vuelta).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MUT = [
  ['otra clave pública', 'publico.mjs', "}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}/", "}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/"],
  ['pierde los faltantes', 'publico.mjs', '    faltantes: fal,\n', '    faltantes: [],\n'],
  /* [2.ª vuelta · Codex n3-262-1511] */
  ['faltantes ausentes → [] (lo de la 1.ª vuelta)', 'publico.mjs', '    faltantes: fal,\n', '    faltantes: Array.isArray(doc.faltantes) ? doc.faltantes : [],\n'],
  ['no marca «desconocido»', 'publico.mjs', "const estado = fal ? doc.estado : 'desconocido';", 'const estado = doc.estado;'],
  ['acepta la incompleta con lista vacía', 'publico.mjs', "if (estado === 'incompleta') return u.length > 0 ? u : null;", "if (estado === 'incompleta') return u;"],
  ['acepta casilleros mal escritos', 'publico.mjs', 'const CASILLERO_RE = /^([0-5]\\d):(00|20|40)$/;', 'const CASILLERO_RE = /./;'],
  ['idempotencia sólo por estado (n3 §3)', 'publico.mjs', 'if (idx.horas[marca] === pub.estado && idx.firmas[marca] === pub.firma)', 'if (idx.horas[marca] === pub.estado)'],
  ['imprime la URL del error', 'publico.mjs', ".replace(/https?:\\/\\/\\S+/g, '[url]')", ''],
  ['no es idempotente', 'publico.mjs', 'if (idx.horas[marca] === pub.estado && idx.firmas[marca] === pub.firma) { res.ya++; continue; }', ''],
  ['no respeta el rango', 'publico.mjs', 'if (h < desdeMs || h > hastaMs) continue;', ''],
  ['sin Cache-Control', 'almacen.mjs', "if (cache) headers['cache-control'] = cache;", ''],
  ['copia la de otra hora', 'publico.mjs', 'if (!pub || Date.parse(pub.hora) !== h) { if (h >= desdeMs && h <= hastaMs) res.ilegibles++; continue; }', 'if (!pub) { if (h >= desdeMs && h <= hastaMs) res.ilegibles++; continue; }'],
  /* [3.ª vuelta · 16/11, datos reales] cada flash a su hora */
  ['no reparte los flashes de los bordes (t_ms negativo)', 'publico.mjs', 'const rep = repartirFlashes(pubs);', 'const rep = { movidos: 0, fuera: 0 };'],
  ['no lee las horas vecinas del rango', 'publico.mjs', 'const lee0 = desdeMs - HORA, lee1 = hastaMs + HORA;', 'const lee0 = desdeMs, lee1 = hastaMs;'],
  ['duplica un flash repetido en las dos horas', 'publico.mjs', 'if (!visto.has(k)) { visto.add(k); todos.push(f); }', 'todos.push(f);'],
  ['sin la hora de destino, lo deja fuera de rango', 'publico.mjs', 'if (!pubs.has(destino)) { res.fuera++; continue; }', 'if (!pubs.has(destino)) { res.fuera++; quedan.push(f); continue; }'],
  ['no corre el t_ms al moverlo', 'publico.mjs', 'const f2 = [t - (destino - h), ...f.slice(1)];', 'const f2 = f;'],
  /* [ajustes finales · sustituta n3-262-sustituta-1511, obs. 3] */
  ['derivar copia campos privados', 'publico.mjs', '    hora: doc.hora,\n', '    ...doc, hora: doc.hora,\n'],
  ['traga el error de escritura', 'publico.mjs', '  if (error) throw error;\n', ''],
];
const correr = (dir) => spawnSync(process.execPath, ['--test', path.join(dir, 'test', 'publico.test.mjs')], { encoding: 'utf8' }).status === 0;
let mal = 0;
const iContra = process.argv.indexOf('--contra');
if (iContra > 0) {   // [2.ª vuelta] contra la punta vieja: la lib/ de esa ref, el test de hoy
  const ref = process.argv[iContra + 1], dir = path.join(RAIZ, '.contra-pub');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  for (const f of fs.readdirSync(path.join(RAIZ, 'lib'))) {
    const g = spawnSync('git', ['show', ref + ':rayos-hora/lib/' + f], { cwd: RAIZ, encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, 'lib', f), g.status === 0 ? g.stdout : fs.readFileSync(path.join(RAIZ, 'lib', f), 'utf8'));
  }
  fs.copyFileSync(path.join(RAIZ, 'test', 'publico.test.mjs'), path.join(dir, 'test', 'publico.test.mjs'));
  const r = spawnSync(process.execPath, ['--test', path.join(dir, 'test', 'publico.test.mjs')], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  const caen = (r.stdout.match(/^✖ .*$/gm) || []).filter((l) => !/^✖ failing tests/.test(l));
  const nombres = Array.from(new Set(caen.map((l) => l.replace(/ \([\d.]+m?s\)$/, ''))));
  nombres.forEach((l) => console.log('  ' + l));
  const fail = Number((/ℹ fail (\d+)/.exec(r.stdout) || [])[1] || 0);
  console.log((r.status === 0 ? '✗ SIGUE VERDE' : '✓ rojo') + ' contra ' + ref + ': ' + fail + ' tests caen');
  process.exit(r.status === 0 ? 1 : 0);
}
for (const [n, arch, de, a] of MUT) {
  const dir = path.join(RAIZ, '.mutante-pub');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true }); fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  for (const f of fs.readdirSync(path.join(RAIZ, 'lib'))) fs.copyFileSync(path.join(RAIZ, 'lib', f), path.join(dir, 'lib', f));
  fs.copyFileSync(path.join(RAIZ, 'test', 'publico.test.mjs'), path.join(dir, 'test', 'publico.test.mjs'));
  const p = path.join(dir, 'lib', arch), s = fs.readFileSync(p, 'utf8');
  if (s.split(de).length !== 2) { console.log('✗ ' + n + ': no encontré el texto'); mal++; continue; }
  fs.writeFileSync(p, s.replace(de, a));
  const verde = correr(dir);
  console.log((verde ? '✗ SIGUE VERDE · ' : '✓ rojo · ') + n); if (verde) mal++;
  fs.rmSync(dir, { recursive: true, force: true });
}
const ok = correr(RAIZ); console.log((ok ? '✓ verde' : '✗ ROJO') + ' · sin romper nada'); if (!ok) mal++;
console.log(mal ? mal + ' mal' : MUT.length + ' de ' + MUT.length + ' mutantes detectados');
process.exit(mal ? 1 : 0);
