// HN AGRO · SMN datos abiertos · leer el ZIP que entrega ssl.smn.gob.ar/dpd/zipopendata.php (sin dependencias).
// Lo mínimo: el directorio central (fin del archivo), cada entrada «stored» (0) o «deflate» (8), con topes para que un
// archivo roto o enorme no tumbe la corrida. Cualquier otra cosa → { ok: false, motivo } (la corrida avisa y no carga).
import zlib from 'node:zlib';

export const TOPE_DESCOMPRIMIDO = 20 * 1024 * 1024;   // el datohorario de un día son ~300 KB; 20 MB ya es otra cosa
const FIN = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

/** Buffer → { ok, entradas: [{ nombre, datos: Buffer }] } o { ok: false, motivo }. */
export function leerZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, motivo: 'zip_corto' };
  if (buf.readUInt32LE(0) !== LOCAL) return { ok: false, motivo: 'no_es_zip' };
  /* el registro de fin está en los últimos 22 + 65535 bytes (comentario opcional) */
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === FIN) { fin = i; break; }
  if (fin < 0) return { ok: false, motivo: 'zip_sin_fin' };
  const n = buf.readUInt16LE(fin + 10), tamCentral = buf.readUInt32LE(fin + 12), ofCentral = buf.readUInt32LE(fin + 16);
  if (ofCentral + tamCentral > fin || n > 50) return { ok: false, motivo: 'zip_central_roto' };
  const entradas = [];
  let p = ofCentral;
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) return { ok: false, motivo: 'zip_central_roto' };
    const metodo = buf.readUInt16LE(p + 10), comp = buf.readUInt32LE(p + 20), tam = buf.readUInt32LE(p + 24);
    const ln = buf.readUInt16LE(p + 28), le = buf.readUInt16LE(p + 30), lc = buf.readUInt16LE(p + 32), ofLocal = buf.readUInt32LE(p + 42);
    const nombre = buf.toString('latin1', p + 46, p + 46 + ln);
    p += 46 + ln + le + lc;
    if (tam > TOPE_DESCOMPRIMIDO) return { ok: false, motivo: 'zip_demasiado_grande' };
    if (ofLocal + 30 > buf.length || buf.readUInt32LE(ofLocal) !== LOCAL) return { ok: false, motivo: 'zip_local_roto' };
    const ini = ofLocal + 30 + buf.readUInt16LE(ofLocal + 26) + buf.readUInt16LE(ofLocal + 28);
    if (ini + comp > buf.length) return { ok: false, motivo: 'zip_cortado' };
    const crudo = buf.subarray(ini, ini + comp);
    let datos;
    try {
      if (metodo === 0) datos = Buffer.from(crudo);
      else if (metodo === 8) datos = zlib.inflateRawSync(crudo, { maxOutputLength: TOPE_DESCOMPRIMIDO });
      else return { ok: false, motivo: 'zip_metodo_' + metodo };
    } catch { return { ok: false, motivo: 'zip_no_descomprime' }; }
    if (datos.length !== tam) return { ok: false, motivo: 'zip_tamano_distinto' };
    entradas.push({ nombre, datos });
  }
  return { ok: true, entradas };
}
