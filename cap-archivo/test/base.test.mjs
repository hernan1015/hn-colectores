// node --test cap-archivo/test/base.test.mjs   (sin red ni base: un `sql` falso)
// El rol colector_cap: otro usuario no conecta, el host tiene que ser el pooler, la sesión se verifica y ningún error
// sale con la URL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crearBase, errorLimpio, usuarioDeUrl, hostDeUrl, ROL } from '../lib/base.mjs';

const URL_OK = 'postgresql://colector_cap.abcdef:clave123@aws-0-sa-east-1.pooler.supabase.com:6543/postgres';

function sqlFalso({ yo = ROL, sesion = ROL, fallarInsert = null } = {}) {
  const hechos = [];
  const sql = async (partes, ...vals) => {
    const t = partes.join('?');
    hechos.push({ t, vals });
    if (/current_user/.test(t)) return [{ u: yo, s: sesion }];
    if (/insert into registro_procesos/.test(t) && fallarInsert) throw fallarInsert;
    return [];
  };
  sql.json = (v) => ({ json: v });
  sql.end = async () => { hechos.push({ t: 'end' }); };
  return { sql, hechos };
}

test('sólo el usuario colector_cap y sólo el pooler de Supabase', async () => {
  assert.equal(usuarioDeUrl(URL_OK), 'colector_cap.abcdef');
  assert.equal(hostDeUrl(URL_OK), 'aws-0-sa-east-1.pooler.supabase.com');
  await assert.rejects(crearBase({ url: URL_OK.replace('colector_cap', 'postgres'), conectar: () => sqlFalso().sql }), /tiene que ser del usuario colector_cap/);
  await assert.rejects(crearBase({ url: URL_OK.replace('colector_cap', 'colector_estaciones'), conectar: () => sqlFalso().sql }), /colector_cap/);
  await assert.rejects(crearBase({ url: URL_OK.replace('aws-0-sa-east-1.pooler.supabase.com', 'evil.example.com'), conectar: () => sqlFalso().sql }), /pooler/);
  await assert.rejects(crearBase({ url: URL_OK.replace('clave123', 'cla@ve'), conectar: () => sqlFalso().sql }), /pooler|codificada/);
  await assert.rejects(crearBase({ url: '', conectar: () => sqlFalso().sql }), /falta CAP_PG_URL/);
});

test('si la sesión entra como otro usuario, se cierra y aborta', async () => {
  const f = sqlFalso({ sesion: 'postgres' });
  await assert.rejects(crearBase({ url: URL_OK, conectar: () => f.sql }), /otro usuario/);
  assert.ok(f.hechos.some((h) => h.t === 'end'));
});

test('registrar: un renglón con proceso, ok y resumen (jsonb); el error sale sin la URL', async () => {
  const f = sqlFalso();
  const b = await crearBase({ url: URL_OK, conectar: () => f.sql });
  await b.registrar('smn_cap_archivo', true, { pedidos: 1 });
  const ins = f.hechos.find((h) => /insert into registro_procesos/.test(h.t));
  assert.deepEqual(ins.vals, ['smn_cap_archivo', true, { json: { pedidos: 1 } }]);
  const g = sqlFalso({ fallarInsert: Object.assign(new Error('permission denied ' + URL_OK), { code: '42501' }) });
  const b2 = await crearBase({ url: URL_OK, conectar: () => g.sql });
  await assert.rejects(b2.registrar('smn_cap_archivo', true, {}), (e) => !String(e.message).includes('pooler') && /42501/.test(e.message));
  assert.ok(!errorLimpio(new Error(URL_OK)).message.includes('clave123'));
});
