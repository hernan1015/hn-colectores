// LIB FALSA de goes-rayos.mjs: flashesVentana y _vaciarCache. Como la de verdad, pide con el fetch GLOBAL
// (medir-caso.mjs lo reemplaza por el de lib/red.mjs) y devuelve los flashes de [desde, hasta).
const B = 'https://noaa-goes19.s3.amazonaws.com';
const pad = (n, w = 2) => String(n).padStart(w, '0');
const doy = (d) => Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
const tDe = (k) => { const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})/.exec(k); return Date.UTC(+m[1], 0, 1, +m[3], +m[4], +m[5]) + (+m[2] - 1) * 864e5; };
export function _vaciarCache() {}
export async function flashesVentana({ desde, hasta }) {
  const horas = [...new Set([desde, hasta - 1].map((x) => Math.floor(x / 3600000) * 3600000))];
  let claves = [];
  for (const h of horas) {
    const d = new Date(h);
    const r = await fetch(B + '/?list-type=2&prefix=' + encodeURIComponent('GLM-L2-LCFA/' + d.getUTCFullYear() + '/' + pad(doy(d), 3) + '/' + pad(d.getUTCHours()) + '/') + '&max-keys=1000');
    if (!r.ok) return { ok: false, motivo: 'sin_listado' };
    claves.push(...((await r.text()).match(/<Key>[^<]+<\/Key>/g) || []).map((x) => x.slice(5, -6)));
  }
  claves = claves.filter((k) => tDe(k) >= desde && tDe(k) < hasta);
  // 24 a la vez, como la de verdad: el fetch del job los tiene que poner en fila
  const res = await Promise.all(claves.map(async (k) => { const r = await fetch(B + '/' + k); return r.ok ? JSON.parse(new TextDecoder().decode(await r.arrayBuffer())) : null; }));
  const leidos = res.filter(Boolean);
  return { ok: leidos.length > 0, completo: leidos.length === claves.length && claves.length === 10, flashes: leidos.flatMap((x) => x.flashes) };
}
export default { flashesVentana, _vaciarCache };
