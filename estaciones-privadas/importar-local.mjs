// Una sola vez: pasa a R2 lo que bajó la notebook el 15/11 antes de que la ronda corriera en la nube.
// Lee los .gz del release privado `estaciones-local-2026-11-15` de hn-radar (RADAR_TOKEN) y los guarda en
// estaciones-internas/<fuente>/2026-11-15/local.jsonl.gz. No imprime contenido, sólo tamaños.
import { almacenR2 } from '../sipan-alto-valle/lib/almacen.mjs';
const r2 = almacenR2({ cuenta: process.env.R2_ACCOUNT_ID, clave: process.env.R2_ACCESS_KEY_ID, secreto: process.env.R2_SECRET_ACCESS_KEY, deposito: process.env.R2_BUCKET });
const H = { Authorization: 'Bearer ' + process.env.RADAR_TOKEN, 'User-Agent': 'hn-colector/1.0' };
const rel = await (await fetch('https://api.github.com/repos/hernan1015/hn-radar/releases/tags/estaciones-local-2026-11-15', { headers: H })).json();
for (const [nombre, fuente] of [['wl-local-2026-11-15.jsonl.gz', 'weatherlink'], ['wc-local-2026-11-15.jsonl.gz', 'weathercloud']]) {
  const a = (rel.assets || []).find((x) => x.name === nombre);
  if (!a) { console.log('falta', nombre); process.exitCode = 1; continue; }
  const r = await fetch(a.url, { headers: { ...H, Accept: 'application/octet-stream' } });
  const buf = Buffer.from(await r.arrayBuffer());
  await r2.escribir(`estaciones-internas/${fuente}/2026-11-15/local.jsonl.gz`, buf, { soloSiNoExiste: true, tipo: 'application/gzip' });
  console.log(fuente, buf.length, 'bytes');
}
