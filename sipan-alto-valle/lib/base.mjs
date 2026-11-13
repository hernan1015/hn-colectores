// HN AGRO · SIPAN Alto Valle · la base (Supabase) por la API REST (PostgREST), sin dependencias. Igual que el vigía
// (vigia/lib/estado.mjs). Las credenciales llegan por variables de entorno que el workflow lee de secrets.* (nunca en
// el código) y nunca se imprimen:
//   SIPAN_SUPABASE_URL       https://<proyecto>.supabase.co
//   SIPAN_SUPABASE_ANON_KEY  la clave anon/publishable del proyecto (la pide la puerta de Supabase; sola no da nada)
//   SIPAN_SUPABASE_JWT       un JWT con {"role":"colector_estaciones"} (migracion/0147b): PostgREST entra con ESE rol,
//                            que sólo escribe las filas de sus redes. ⛔ NO la clave de servicio: si llega un JWT con otro
//                            rol (service_role, anon, authenticated…), el colector se niega a arrancar.
//
// Tablas: estaciones y estaciones_obs (hn-agro migrations/0110 + las columnas de la 0147), registro_procesos (0075) y
// pronostico_helada_medicion (0147).
export const RED = 'INTA_SIPAN_AV';
export const ROL = 'colector_estaciones';

/** El claim `role` de un JWT (sin verificar la firma: eso lo hace Supabase). null si no es un JWT. */
export function rolDelJwt(jwt) {
  try {
    const p = String(jwt).split('.');
    if (p.length !== 3) return null;
    return JSON.parse(Buffer.from(p[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).role ?? null;
  } catch { return null; }
}

export function crearBase({ url, apikey, jwt, fetchFn = globalThis.fetch }) {
  if (!url || !apikey || !jwt) throw new Error('faltan SIPAN_SUPABASE_URL, SIPAN_SUPABASE_ANON_KEY o SIPAN_SUPABASE_JWT');
  const rol = rolDelJwt(jwt);
  if (rol !== ROL) throw new Error(`SIPAN_SUPABASE_JWT tiene que ser del rol ${ROL} (llegó ${rol ? 'otro rol' : 'algo que no es un JWT'}): no se usa la clave de servicio`);
  const base = url.replace(/\/+$/, '') + '/rest/v1/';
  const H = { apikey, Authorization: 'Bearer ' + jwt, 'Content-Type': 'application/json' };
  async function pedir(metodo, ruta, cuerpo, extra = {}) {
    const r = await fetchFn(base + ruta, { method: metodo, headers: { ...H, ...extra }, body: cuerpo ? JSON.stringify(cuerpo) : undefined, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Supabase ${metodo} ${ruta.split('?')[0]}: HTTP ${r.status}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  const lista = (xs) => '(' + xs.map((x) => '"' + String(x).replace(/"/g, '') + '"').join(',') + ')';
  return {
    async estaciones() {
      return (await pedir('GET', `estaciones?red=eq.${RED}&select=estacion_id,nombre,lat,lon,activa,metadatos`)) || [];
    },
    async guardarEstaciones(filas) {
      if (!filas.length) return;
      await pedir('POST', 'estaciones?on_conflict=red,estacion_id', filas, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    },
    async obs(estacionId, fechas) {
      if (!fechas.length) return [];
      return (await pedir('GET', `estaciones_obs?red=eq.${RED}&estacion_id=eq.${encodeURIComponent(estacionId)}&fecha=in.${encodeURIComponent(lista(fechas))}&select=*`)) || [];
    },
    async obsDesde(desde) {
      return (await pedir('GET', `estaciones_obs?red=eq.${RED}&fecha=gte.${desde}&select=estacion_id,fecha,tmin_c,tmin_noche_c,tmin_noche_en,noche_registros,noche_esperados,registros_validos,registros_esperados`)) || [];
    },
    async guardarObs(filas) {
      /* una por una: así una fila mala (un CHECK) no tira las demás, y cada una lleva todas sus columnas */
      let ok = 0; const errores = [];
      for (const f of filas) {
        try { await pedir('POST', 'estaciones_obs?on_conflict=red,estacion_id,fecha', [f], { Prefer: 'resolution=merge-duplicates,return=minimal' }); ok++; }
        catch (e) { errores.push(`${f.estacion_id} ${f.fecha}: ${String(e.message).slice(0, 80)}`); }
      }
      return { ok, errores };
    },
    async guardarMedicion(filas) {
      if (!filas.length) return;
      await pedir('POST', 'pronostico_helada_medicion?on_conflict=red,estacion_id,noche,fuente,anticipacion_dias', filas, { Prefer: 'resolution=merge-duplicates,return=minimal' });
    },
    async registrar(proceso, ok, resumen) {
      let txt = JSON.stringify(resumen);
      if (txt.length > 60000) { resumen = { recortado: true, largo: txt.length, avisos: resumen.avisos }; txt = JSON.stringify(resumen); }
      await pedir('POST', 'registro_procesos', [{ proceso, ok, resumen }], { Prefer: 'return=minimal' });
    },
  };
}
