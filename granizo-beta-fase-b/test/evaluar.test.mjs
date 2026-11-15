// node --test test/evaluar.test.mjs · el veredicto del sello sobre filas SINTÉTICAS (15 + 14), con sus controles negativos:
// una variante que enciende todo el dominio no puede salir «MEJORA» (falsas alarmas, días barajados y hora corrida la frenan).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluar, senales, salto, desarreglos, wilson, I1_ESPERADO } from '../lib/evaluar.mjs';
import { casos, K10 } from '../lib/plan.mjs';
import { leerParticion } from '../medir-caso.mjs';

const dia = (i) => new Date(Date.UTC(2026, 0, 5 + 2 * i)).toISOString().slice(0, 10);
const P = {
  confirmados: Array.from({ length: 15 }, (_, i) => ({ episodio: dia(i), eventos: [{ id: 'C' + i, lat: -20 - i, lon: -60, t: dia(i) + 'T20:00Z', ini: dia(i) + 'T19:00Z', fin: dia(i) + 'T20:00Z' }] })),
  controles: Array.from({ length: 14 }, (_, i) => ({ episodio: dia(15 + i), horas: [{ id: 'A' + i, estacion: 'X', lat: -20 - i, lon: -50, ini: dia(15 + i) + 'T18:00Z', fin: dia(15 + i) + 'T19:00Z' }] }))
};
const LUGARES = [...P.confirmados.map((e) => [e.eventos[0].lat, e.eventos[0].lon]), ...P.controles.map((c) => [c.horas[0].lat, c.horas[0].lon])];
const ALTURA_RAYOS = { patas: 2, patas_cuales: ['altura', 'rayos'], destacada: false, incompleta: false, rayos: 30 };
/** filas de un escenario: cel(caso, idx, rol, t) → celdas */
function filas(cel, { sacar = [] } = {}) {
  const out = [];
  for (const c of casos(P)) {
    if (sacar.includes(c.caso)) continue;
    const ks = new Set();
    for (const v of c.ventanas) for (let k = Math.ceil(v.desde / 6e5) - 1; k * 6e5 <= v.hasta; k++) ks.add(k);
    for (const k of [...ks].sort((a, b) => a - b)) {
      const t = k * 6e5 + 20000, rol = c.ventanas.find((v) => t >= v.desde && t <= v.hasta)?.rol || null;
      const celdas = cel(c, rol, t);
      out.push({ caso: c.caso, tipo: c.tipo, sat: 'goes19', scan_pedido: 'goes19|' + new Date(t).toISOString(), t: new Date(t).toISOString(), k10: K10(t),
        creado: new Date(t + 12 * 60000).toISOString(), publicado: new Date(t + 13 * 60000).toISOString(),
        como_19: { ok: true, faltantes: ['actp_t'], valido: true, scan_t: new Date(t + 500).toISOString(), destacadas: celdas.filter((x) => x.destacada) },
        con_fase: { ok: true, parcial: false, valido: true, glm_completo: true, t10_disponible: ks.has(k - 1), celdas } });
    }
  }
  return out;
}
const lugarDe = (c) => (c.tipo === 'confirmado' ? P.confirmados.find((e) => e.episodio === c.caso).eventos[0] : P.controles.find((x) => x.episodio === c.caso).horas[0]);
const idx = (c) => (c.tipo === 'confirmado' ? P.confirmados.findIndex((e) => e.episodio === c.caso) : -1);
const ESP = { confirmados: [dia(0), dia(1)], controles: [] };
// V0: destacada sobre el evento de los 2 primeros confirmados
const base = (c, rol) => (rol === 'real' && idx(c) >= 0 && idx(c) < 2 ? [{ ...ALTURA_RAYOS, patas: 3, patas_cuales: ['altura', 'crece', 'rayos'], destacada: true, lat: lugarDe(c).lat, lon: lugarDe(c).lon }] : []);
const saltoEn = (lat, lon) => ({ ...ALTURA_RAYOS, lat, lon, n25_t: 45, n25_t10: 10 });

test('el salto con los umbrales del sello', () => {
  assert.equal(salto(40, 20), true);
  assert.equal(salto(30, 10), true);
  assert.equal(salto(30, 15), false, 'la diferencia (15) no llega a 20');
  assert.equal(salto(29, 0), false, 'N(t) ≥ 30');
  assert.equal(salto(40, 21), false, 'el doble');
  assert.equal(salto(39, 19), true);
  assert.equal(salto(35, 16), false, 'diferencia ≥ 20');
  assert.equal(salto(50, null), false, 'sin t−10 no hay salto');
});

test('desarreglos: 200, ninguno deja un episodio en su lugar, siempre los mismos (semilla 226)', () => {
  const a = desarreglos(29), b = desarreglos(29);
  assert.equal(a.length, 200);
  assert.ok(a.every((p) => p.every((v, i) => v !== i) && new Set(p).size === 29));
  assert.deepEqual(a, b);
  assert.deepEqual(wilson(4, 15).ic, [0.109, 0.52]);
});

test('V1 que marca SÓLO el granizo: MEJORA', () => {
  const F = filas((c, rol) => base(c, rol).concat(rol === 'real' && idx(c) >= 2 && idx(c) < 10 ? [saltoEn(lugarDe(c).lat, lugarDe(c).lon)] : []));
  const r = evaluar(P, F, { esperadoI1: ESP });
  assert.equal(r.veredicto, 'MEJORA', JSON.stringify(r.falla));
  assert.equal(r.variantes.V0.POD.k, 2); assert.equal(r.variantes.V1.POD.k, 10);
  assert.equal(r.variantes.V1.POFD.k, 0);
  assert.equal(r.criterio.a_nuevos.valor, 8);
  assert.ok(r.C_dias.V1.en_regla && r.C_hora.V1.en_regla);
  assert.equal(r.I1.en_regla, true);
  assert.ok(r.variantes.V1.anticipacion_min.vs_creacion.valores.length === 10);
});

test('CONTROL NEGATIVO: un V1 que enciende todo el dominio todo el tiempo NO mejora (falsas alarmas, días y hora)', () => {
  const F = filas((c, rol) => base(c, rol).concat(LUGARES.map(([la, lo]) => saltoEn(la, lo))));
  const r = evaluar(P, F, { esperadoI1: ESP });
  assert.equal(r.veredicto, 'NO_MEJORA');
  assert.equal(r.variantes.V1.POD.k, 15);
  assert.equal(r.variantes.V1.POFD.k, 14);
  assert.equal(r.criterio.b_controles_nuevos.en_regla, false);
  assert.equal(r.C_dias.V1.en_regla, false, 'con los días barajados acierta lo mismo');
  assert.equal(r.C_hora.V1.en_regla, false, 'con la hora corrida acierta lo mismo');
});

test('CONTROL NEGATIVO: días de tormenta sin hora (señal todo el día sobre el lugar): C_hora lo frena', () => {
  const F = filas((c, rol) => base(c, rol).concat(c.tipo === 'confirmado' ? [saltoEn(lugarDe(c).lat, lugarDe(c).lon)] : []));
  const r = evaluar(P, F, { esperadoI1: ESP });
  assert.equal(r.veredicto, 'NO_MEJORA');
  assert.equal(r.C_hora.V1.en_regla, false);
  assert.ok(r.falla.includes('d_controles'));
});

test('el salto pide el barrido de 10 min antes válido y con GLM completo', () => {
  const F = filas((c, rol) => (rol === 'real' && idx(c) === 3 ? [saltoEn(lugarDe(c).lat, lugarDe(c).lon)] : []));
  const caso = F.filter((f) => f.caso === dia(3));
  assert.ok(senales(caso).V1.length > 0);
  for (const f of caso) f.con_fase.glm_completo = f.k10 % 2 === 0;   // uno sí, uno no: ninguno tiene su anterior completo… salvo los pares sin salto
  const conSalto = senales(caso).V1;
  for (const s of conSalto) assert.ok(caso.find((f) => f.k10 === K10(s.t) - 1).con_fase.glm_completo);
  for (const f of caso) f.con_fase.valido = false;
  assert.equal(senales(caso).V1.length, 0, 'un barrido no válido no da señal');
});

test('NO_INFORMA: si V0 no reproduce a la 19, o si faltan más de 3 episodios', () => {
  const F = filas((c, rol) => base(c, rol));
  assert.equal(evaluar(P, F, { esperadoI1: { confirmados: [dia(0)], controles: [] } }).veredicto, 'NO_INFORMA');
  const F2 = filas((c, rol) => base(c, rol), { sacar: [dia(5), dia(6), dia(7), dia(8)] });
  const r2 = evaluar(P, F2, { esperadoI1: ESP });
  assert.equal(r2.veredicto, 'NO_INFORMA');
  assert.equal(r2.sin_dato.confirmados, 4);
});

test('I1 con la muestra de verdad: los 4 + 1 de la 19 (lo que el sello espera)', () => {
  const PR = leerParticion();
  assert.deepEqual(I1_ESPERADO, { confirmados: ['2022-02-27', '2023-05-25', '2023-10-29', '2025-05-17'], controles: ['2026-04-01'] });
  assert.ok(I1_ESPERADO.confirmados.every((e) => PR.confirmados.some((x) => x.episodio === e)));
  assert.ok(PR.controles.some((x) => x.episodio === '2026-04-01'));
});

test('el radio de 30 km: a 29 km acierta, a 31 km no', () => {
  const d = (km) => km / 111.195;
  const F1 = filas((c, rol) => (rol === 'real' && idx(c) === 4 ? [saltoEn(lugarDe(c).lat + d(29), lugarDe(c).lon)] : []));
  const F2 = filas((c, rol) => (rol === 'real' && idx(c) === 4 ? [saltoEn(lugarDe(c).lat + d(31), lugarDe(c).lon)] : []));
  assert.deepEqual(evaluar(P, F1, { esperadoI1: { confirmados: [], controles: [] } }).variantes.V1.acertados, [dia(4)]);
  assert.deepEqual(evaluar(P, F2, { esperadoI1: { confirmados: [], controles: [] } }).variantes.V1.acertados, []);
});

test('con sólo 2 episodios nuevos NO mejora (hacen falta 3)', () => {
  const F = filas((c, rol) => base(c, rol).concat(rol === 'real' && (idx(c) === 2 || idx(c) === 3) ? [saltoEn(lugarDe(c).lat, lugarDe(c).lon)] : []));
  const r = evaluar(P, F, { esperadoI1: ESP });
  assert.equal(r.veredicto, 'NO_MEJORA');
  assert.equal(r.criterio.a_nuevos.valor, 2);
  assert.ok(r.falla.includes('a_nuevos'));
  const F3 = filas((c, rol) => base(c, rol).concat(rol === 'real' && idx(c) >= 2 && idx(c) <= 4 ? [saltoEn(lugarDe(c).lat, lugarDe(c).lon)] : []));
  const r3 = evaluar(P, F3, { esperadoI1: ESP });
  assert.equal(r3.criterio.a_nuevos.en_regla, true, '3 sí');
});

test('CONTROL NEGATIVO: señal en los lugares del granizo también en los días de control: C_dias lo frena (sola)', () => {
  const EV = P.confirmados.map((e) => [e.eventos[0].lat, e.eventos[0].lon]);
  const F = filas((c, rol) => base(c, rol).concat(rol === 'real' ? EV.map(([la, lo]) => saltoEn(la, lo)) : []));
  const r = evaluar(P, F, { esperadoI1: ESP });
  assert.equal(r.variantes.V1.POFD.k, 0, 'las estaciones de control no se encienden');
  assert.ok(r.criterio.a_nuevos.en_regla && r.criterio.b_controles_nuevos.en_regla && r.criterio.c_dPSS.en_regla && r.C_hora.V1.en_regla);
  assert.equal(r.C_dias.V1.en_regla, false);
  assert.equal(r.veredicto, 'NO_MEJORA');
  assert.deepEqual(r.falla, ['d_controles']);
});

test('un barrido no válido no cuenta ni para V0', () => {
  const F = filas((c, rol) => base(c, rol));
  const d0 = F.filter((f) => f.caso === dia(0) && f.con_fase.celdas.length);
  for (const f of d0) f.con_fase.valido = false;
  d0[0].con_fase = { ...d0[0].con_fase, valido: true, celdas: [] };   // queda uno válido y vacío: hay dato
  const r = evaluar(P, F, { esperadoI1: ESP });
  assert.ok(!r.variantes.V0.acertados.includes(dia(0)), 'la destacada de un barrido no válido no acierta');
  assert.ok(!r.variantes.V0.sin_dato.confirmados.includes(dia(0)), 'con un válido, hay dato');
  for (const f of F) if (f.caso === dia(0)) f.con_fase.valido = false;
  assert.ok(evaluar(P, F, { esperadoI1: ESP }).variantes.V0.sin_dato.confirmados.includes(dia(0)), 'sin ninguno válido sale del denominador');
});
