// HN AGRO · goes-serie · la ventana de un evento: copia t0 ± 6 h de goes-serie/ a goes-eventos/<evento>/, SIN ROTACIÓN.
//
// REGLAS
//  - Copia del lado del servidor (CopyObject). Si R2 no la acepta, baja y sube (y entonces compara el sha256 con el
//    del índice). En los dos casos, al final se lista el destino y cada tamaño tiene que dar igual al del origen.
//  - Nunca borra nada y nunca pisa: lo que ya está en goes-eventos/<evento>/ no se vuelve a copiar.
//  - Un evento que ya existe con OTRO lugar u otra hora no se toca (error evento_ya_existe_con_otros_datos).
//  - Lo que no se pudo copiar va al manifiesto con su motivo: «rotada» (más de 30 días), «pendiente» (todavía no
//    pasó o no cerró), «sin_imagen_en_serie» (la serie no la tiene) o el código del error. Nunca se rellena.
//  - Se puede volver a correr con los mismos datos: completa lo que falte (por ejemplo, las horas después de t0).
import crypto from 'node:crypto';
import {
  RE_EVENTO, RETENCION_DIAS, MARGEN_CIERRE_MS, VENTANA_EVENTO_H, TIPO,
  turnosEvento, partes, isoTurno, claveImagen, claveIndice, prefijoDia, claveEventoImagen, claveManifiesto, PREFIJO_EVENTOS,
} from './claves.mjs';
import { codigoDe, errorCodigo } from './r2.mjs';
import { PRODUCTO, SATELITE } from './noaa.mjs';

const DIA_MS = 864e5;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** PURA. Valida la entrada → { evento, lat, lon, t0Ms } o lanza un código */
export function validarEntrada({ evento, lat, lon, t0 }, ahoraMs) {
  const ev = String(evento || '').trim();
  if (!RE_EVENTO.test(ev)) throw errorCodigo('evento_invalido');
  const la = Number(lat), lo = Number(lon);
  if (String(lat ?? '').trim() === '' || String(lon ?? '').trim() === '' || !Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) throw errorCodigo('lat_lon_invalidos');
  const s = String(t0 || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(s)) throw errorCodigo('t0_invalido');
  const t0Ms = Date.parse(s);
  if (!Number.isFinite(t0Ms)) throw errorCodigo('t0_invalido');
  if (t0Ms > ahoraMs + 3600e3) throw errorCodigo('t0_en_el_futuro');
  if (t0Ms + VENTANA_EVENTO_H * 3600e3 < ahoraMs - RETENCION_DIAS * DIA_MS) throw errorCodigo('t0_fuera_de_la_serie');
  return { evento: ev, lat: r4(la), lon: r4(lo), t0Ms };
}

/**
 * dep: { r2: {listar, leer, escribir, copiar} }
 * → { evento, copiadas, ya_estaban, faltan:[{turno, motivo}], pendientes, metodo, completo, codigo, errores, avisos }
 */
export async function copiarEvento(dep, entrada, { ahora = new Date() } = {}) {
  const { r2 } = dep;
  const ahoraMs = ahora.getTime();
  const res = { evento: null, copiadas: 0, ya_estaban: 0, faltan: [], pendientes: 0, metodo: 'servidor', completo: false, avisos: [], errores: [], codigo: 0 };
  let e;
  try { e = validarEntrada(entrada, ahoraMs); } catch (x) { res.errores.push(codigoDe(x)); res.codigo = 2; return res; }
  res.evento = e.evento;
  const kMan = claveManifiesto(e.evento);
  const prefEv = `${PREFIJO_EVENTOS}${e.evento}/`;

  // 1 · el manifiesto que había (si el evento ya existe con otros datos, no se toca)
  let previo = null;
  try {
    const b = await r2.leer(kMan);
    if (b) previo = JSON.parse(b.toString('utf8'));
  } catch (x) { res.errores.push(`manifiesto: ${codigoDe(x)}`); res.codigo = 2; return res; }
  if (previo && (previo.lat !== e.lat || previo.lon !== e.lon || Date.parse(previo.t0) !== e.t0Ms)) {
    res.errores.push('evento_ya_existe_con_otros_datos'); res.codigo = 2; return res;
  }

  // 2 · qué hay: en la serie (días de la ventana) y en el evento
  const turnos = turnosEvento(e.t0Ms);
  const dias = [...new Set(turnos.map((t) => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())))];
  const serie = new Map(), indices = new Map(), destino = new Map();
  try {
    for (const d of dias) {
      for (const o of await r2.listar(prefijoDia(d))) serie.set(o.clave, o);
      const b = await r2.leer(claveIndice(d));
      if (b) { try { for (const x of JSON.parse(b.toString('utf8')).imagenes || []) indices.set(x.clave, x); } catch { res.avisos.push(`${claveIndice(d)} ilegible: sin sha256 ni nombre de NOAA para ese día`); } }
    }
    for (const o of await r2.listar(prefEv)) destino.set(o.clave, o);
  } catch (x) { res.errores.push(`listar: ${codigoDe(x)}`); res.codigo = 2; return res; }

  // 3 · copiar turno por turno (de a uno: son 73 como mucho)
  const copiadas = new Map(((previo && previo.imagenes) || []).map((x) => [x.clave, x]));
  let soportaCopia = true;
  for (const t of turnos) {
    const origen = claveImagen(t), dest = claveEventoImagen(e.evento, t);
    const meta = indices.get(origen) || {};
    const fila = { turno: isoTurno(t), hhmm: partes(t).hhmm, clave: dest, origen, archivo: meta.archivo || null, t_scan: meta.t_scan || null, bytes: null, sha256: meta.sha256 || null };
    if (destino.has(dest)) { res.ya_estaban++; if (!copiadas.has(dest)) copiadas.set(dest, { ...fila, bytes: destino.get(dest).bytes }); continue; }
    const o = serie.get(origen);
    if (!o) {
      if (t + MARGEN_CIERRE_MS > ahoraMs) { res.pendientes++; continue; }
      res.faltan.push({ turno: isoTurno(t), motivo: t < ahoraMs - RETENCION_DIAS * DIA_MS ? 'rotada' : 'sin_imagen_en_serie' });
      continue;
    }
    try {
      if (soportaCopia) {
        try { await r2.copiar(origen, dest); }
        catch (x) { if (codigoDe(x) !== 'r2_copiar_no_soportado') throw x; soportaCopia = false; res.metodo = 'bajar_y_subir'; res.avisos.push('R2 no aceptó la copia del lado del servidor: se baja y se sube'); }
      }
      if (!soportaCopia) {
        const b = await r2.leer(origen);
        if (!b) throw errorCodigo('origen_desaparecio');
        if (b.length !== o.bytes) throw errorCodigo('origen_tamano_distinto');
        const sha = crypto.createHash('sha256').update(b).digest('hex');
        if (meta.sha256 && sha !== meta.sha256) throw errorCodigo('origen_sha256_distinto');
        fila.sha256 = sha;
        await r2.escribir(dest, b, { tipo: TIPO, soloSiNoExiste: true });
      }
      fila.bytes = o.bytes;
      copiadas.set(dest, fila);
      res.copiadas++;
    } catch (x) { res.faltan.push({ turno: isoTurno(t), motivo: codigoDe(x) }); }
  }

  // 4 · verificar: cada copia tiene que estar en el destino con el mismo tamaño que el origen
  try {
    const ahoraDest = new Map((await r2.listar(prefEv)).map((o) => [o.clave, o]));
    for (const [k, f] of [...copiadas]) {
      const d = ahoraDest.get(k);
      if (!d || (f.bytes != null && d.bytes !== f.bytes)) {
        copiadas.delete(k);
        res.faltan.push({ turno: f.turno, motivo: d ? 'copia_tamano_distinto' : 'copia_no_aparece' });
        res.copiadas = Math.max(0, res.copiadas - 1);
      }
    }
  } catch (x) { res.errores.push(`verificar: ${codigoDe(x)}`); }

  // 5 · el manifiesto (último: si se corta antes, la próxima corrida completa)
  res.completo = !res.faltan.length && !res.pendientes && !res.errores.length;
  const man = {
    v: 1,
    evento: e.evento, lat: e.lat, lon: e.lon,
    t0: new Date(e.t0Ms).toISOString(),
    ventana: { desde: isoTurno(turnos[0]), hasta: isoTurno(turnos[turnos.length - 1]), horas: VENTANA_EVENTO_H, turnos: turnos.length },
    producto: `${SATELITE} ${PRODUCTO} (el archivo de NOAA entero, copiado de goes-serie/)`,
    imagenes: [...copiadas.values()].sort((a, b) => (a.turno < b.turno ? -1 : 1)),
    faltan: res.faltan,
    pendientes: res.pendientes,
    completo: res.completo,
    metodo_copia: res.metodo,
    rotacion: 'ninguna: lo de goes-eventos/ no se borra',
    nota: 'Una imagen que falta es «sin dato», no «sin fuego». lat/lon es el lugar del evento: la imagen es el disco completo.',
    creado: (previo && previo.creado) || new Date(ahoraMs).toISOString(),
    actualizado: new Date(ahoraMs).toISOString(),
  };
  try { await r2.escribir(kMan, JSON.stringify(man)); } catch (x) { res.errores.push(`escribir manifiesto: ${codigoDe(x)}`); }
  if (res.errores.length) res.codigo = 2;
  else if (res.faltan.length) res.codigo = 1;
  return res;
}
