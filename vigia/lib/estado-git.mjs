// HN AGRO · vigía de SATCHI · EL ESTADO EN EL REPO (backend por defecto; decisión de local 10/11 18:48).
// `estado.json` en la rama HUÉRFANA `vigia-estado` de hn-colectores. Sólo claves PÚBLICAS: la escala o el foco, si
// está activo y las fechas (y la posición del foco, que hace falta para no repetirlo). Nada de destinatarios.
// El workflow da `contents: write` sólo a este job, con el GITHUB_TOKEN de Actions (actions/checkout deja el
// remoto autenticado): no hay PAT.
// ORDEN PARA NO MANDAR DOBLE: primero se GUARDA el estado (commit + push) y recién si el push salió se manda el mail.
//   · push rechazado → UN reintento con `git pull --rebase` (pedido de local) → si vuelve a fallar: NO hay mail;
//   · si el mail falla DESPUÉS de guardar, ese aviso se pierde (mejor perder uno que mandarlo dos veces).
// Un renglón por clave, ordenado: dos corridas que tocan claves distintas se rebasan sin conflicto.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nuevos } from './reglas.mjs';

export const RAMA = 'vigia-estado';
export const ARCHIVO = 'estado.json';
const QUIEN = ['-c', 'user.name=vigia-satchi', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
const CAMPOS = ['clave', 'tipo', 'activo', 'primer_aviso', 'ultimo_aviso', 'actualizado'];

/** lo que se guarda de un aviso: sólo lo público y lo necesario */
export function filaDe(a, t, previa) {
  const f = { clave: a.clave, tipo: a.tipo, activo: true, primer_aviso: (previa && previa.primer_aviso) || t, ultimo_aviso: t, actualizado: t };
  if (a.tipo === 'foco') f.detalle = { lat: a.lat, lon: a.lon, provincia: a.provincia };
  return f;
}
/** el texto del archivo: un objeto por renglón, por clave; se sacan los focos de más de 48 h y lo inactivo de más de 30 días */
export function serializar(mapa, ahoraMs) {
  const viva = (f) => (f.tipo === 'foco' ? ahoraMs - Date.parse(f.ultimo_aviso) < 48 * 3600e3 : (f.activo || ahoraMs - Date.parse(f.actualizado) < 30 * 864e5));
  const filas = [...mapa.values()].filter(viva).sort((a, b) => (a.clave < b.clave ? -1 : 1))
    .map((f) => JSON.stringify(Object.fromEntries([...CAMPOS, 'detalle'].filter((k) => f[k] !== undefined).map((k) => [k, f[k]]))));
  return '[\n' + filas.join(',\n') + '\n]\n';
}
export function parsear(txt) {
  const m = new Map();
  for (const f of JSON.parse(txt || '[]')) m.set(f.clave, f);
  return m;
}

export function crearEstadoGit({ repo = process.cwd(), remoto = 'origin', rama = RAMA, log = () => {}, _antesDePush = null } = {}) {
  const git = (args, cwd = repo, ok = false) => {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { if (ok) return null; throw new Error('git ' + args[0] + ' falló'); }   // sin el detalle: puede traer la URL del remoto
  };
  let base = null;   // el estado leído al empezar
  const existe = () => git(['ls-remote', '--exit-code', '--heads', remoto, rama], repo, true) != null;
  return {
    async leer() {
      if (!existe()) { base = new Map(); return new Map(base); }
      git(['fetch', '-q', remoto, rama]);
      base = parsear(git(['show', 'FETCH_HEAD:' + ARCHIVO], repo, true) || '[]');
      return new Map(base);
    },
    /**
     * Aplica lo de esta corrida SOBRE EL ESTADO MÁS NUEVO DEL REMOTO (no sobre el que se leyó al empezar: otra corrida
     * pudo guardar en el medio) y lo sube. Devuelve los avisos que HAY QUE MANDAR (los que siguen siendo nuevos contra
     * ese estado: si otra corrida ya avisó lo mismo, se cae de la lista), o false si no se pudo guardar (no hay mail).
     */
    async guardar({ avisar = [], rearmar = [], ahoraMs }) {
      const t = new Date(ahoraMs).toISOString();
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigia-estado-'));
      try {
        const hay = existe();
        if (hay) {
          git(['fetch', '-q', remoto, rama]);
          git(['worktree', 'add', '-q', '--detach', dir, 'FETCH_HEAD']);
        } else {
          git(['worktree', 'add', '-q', '--detach', dir]);
          git(['checkout', '-q', '--orphan', 'vigia-estado-tmp-' + process.pid], dir);
          git(['rm', '-rq', '--cached', '.'], dir, true);
          for (const n of fs.readdirSync(dir)) if (n !== '.git') fs.rmSync(path.join(dir, n), { recursive: true, force: true });
        }
        const ultimo = hay && fs.existsSync(path.join(dir, ARCHIVO)) ? parsear(fs.readFileSync(path.join(dir, ARCHIVO), 'utf8')) : new Map();
        const efectivos = nuevos(avisar, ultimo, ahoraMs);   // lo que otra corrida ya avisó no se manda de nuevo
        const m = new Map(ultimo);
        for (const a of efectivos) m.set(a.clave, filaDe(a, t, m.get(a.clave)));
        for (const k of rearmar) { const f = m.get(k); if (f && f.activo) m.set(k, { ...f, activo: false, actualizado: t }); }
        fs.writeFileSync(path.join(dir, ARCHIVO), serializar(m, ahoraMs));
        git(['add', ARCHIVO], dir);
        if (git(['diff', '--cached', '--quiet'], dir, true) != null) return efectivos;   // nada cambió: no se commitea
        git([...QUIEN, 'commit', '-q', '-m', 'vigía: estado ' + t], dir);
        if (_antesDePush) _antesDePush();
        if (git(['push', '-q', remoto, 'HEAD:refs/heads/' + rama], dir, true) != null) return efectivos;
        log('el push del estado falló: un reintento con pull --rebase');
        if (git([...QUIEN, 'pull', '-q', '--rebase', remoto, rama], dir, true) == null) { git(['rebase', '--abort'], dir, true); return false; }
        return git(['push', '-q', remoto, 'HEAD:refs/heads/' + rama], dir, true) != null ? efectivos : false;
      } finally {
        git(['worktree', 'remove', '--force', dir], repo, true);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
