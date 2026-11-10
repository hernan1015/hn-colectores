// HN AGRO · vigía de SATCHI · EL ESTADO EN SUPABASE (OPCIONAL: SATCHI_VIGIA_ESTADO=supabase; por defecto va en el repo,
// ver estado-git.mjs). Tabla satchi_vigia_avisos (migracion/, sin aplicar).
// Por la API REST de Supabase (PostgREST), sin dependencias. Las credenciales llegan por variables de entorno que el
// workflow lee de secrets.* (nunca en el código): SATCHI_VIGIA_SUPABASE_URL y SATCHI_VIGIA_SUPABASE_KEY.
// En --seco no se usa: el estado sale de un archivo local opcional (--estado archivo.json) o vacío.
import fs from 'node:fs';

export function estadoDeArchivo(ruta) {
  const m = new Map();
  if (!ruta || !fs.existsSync(ruta)) return m;
  for (const f of JSON.parse(fs.readFileSync(ruta, 'utf8'))) m.set(f.clave, f);
  return m;
}

export function crearEstadoSupabase({ url, clave, fetchFn = globalThis.fetch }) {
  if (!url || !clave) throw new Error('faltan SATCHI_VIGIA_SUPABASE_URL o SATCHI_VIGIA_SUPABASE_KEY');
  const base = url.replace(/\/+$/, '') + '/rest/v1/satchi_vigia_avisos';
  const H = { apikey: clave, Authorization: 'Bearer ' + clave, 'Content-Type': 'application/json' };
  async function pedir(metodo, q, cuerpo, extra = {}) {
    const r = await fetchFn(base + q, { method: metodo, headers: { ...H, ...extra }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
    if (!r.ok) throw new Error('Supabase HTTP ' + r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  return {
    /** activos (crecidas) + focos de las últimas 48 h */
    async leer(ahoraMs) {
      const desde = new Date(ahoraMs - 48 * 3600e3).toISOString();
      const filas = await pedir('GET', '?select=clave,tipo,activo,detalle,primer_aviso,ultimo_aviso&or=(activo.eq.true,ultimo_aviso.gte.' + desde + ')');
      return new Map((filas || []).map((f) => [f.clave, f]));
    },
    /** marca avisado (upsert) */
    async avisado(avisos, ahoraMs) {
      if (!avisos.length) return;
      const t = new Date(ahoraMs).toISOString();
      await pedir('POST', '?on_conflict=clave', avisos.map((a) => ({ clave: a.clave, tipo: a.tipo, activo: true, detalle: a, primer_aviso: t, ultimo_aviso: t, actualizado: t })),
        { Prefer: 'resolution=merge-duplicates,return=minimal' });
    },
    /** lo de esta corrida, en el mismo orden que el backend git: primero se guarda, después (si salió) va el mail */
    async guardar({ avisar = [], rearmar = [], ahoraMs }) {
      try { await this.avisado(avisar, ahoraMs); await this.rearmar(rearmar, ahoraMs); return avisar; } catch (e) { return false; }
    },
    /** rearma: las claves que ya no cruzan el umbral dejan de estar activas (sin mail) */
    async rearmar(claves, ahoraMs) {
      if (!claves.length) return;
      const lista = claves.map((c) => '"' + c.replace(/"/g, '') + '"').join(',');
      await pedir('PATCH', '?activo=eq.true&clave=in.(' + encodeURIComponent(lista) + ')', { activo: false, actualizado: new Date(ahoraMs).toISOString() },
        { Prefer: 'return=minimal' });
    },
  };
}
