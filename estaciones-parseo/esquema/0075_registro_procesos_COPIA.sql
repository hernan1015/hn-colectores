-- ════════════════════════════════════════════════════════════════════════════
-- 0075 · REGISTRO DE PROCESOS QUE CORREN SOLOS
-- ════════════════════════════════════════════════════════════════════════════
-- ⛔ POR QUÉ (medido el 20/08/2026, tres corridas seguidas contra producción):
--   los logs de una background function NO LLEGAN a `netlify logs`. Se ve la marca
--   de invocación y nada más: ni el console.log del resumen, ni un hito puesto en
--   la primera línea del handler, ni a los 40 minutos. Todas las demás functions
--   dejan su salida y su línea de Duration; las background, no.
--
--   El recálculo semanal ES una background function: corre el lunes 05:00 ART sin
--   nadie mirando. Sin esta tabla, la única forma de saber qué hizo es deducirlo de
--   si aparecen filas en historico_motor_q — y ahí no se puede distinguir "no había
--   nada que hacer" de "se rompió". Es la misma falla silenciosa que nos costó el
--   día: todo verde y nada atrás.
--
-- ⚠ NO es una tabla de auditoría ni de facturación: es para MIRARLA. Por eso el
--   resumen va recortado a 60 KB desde el código y hay una poda por antigüedad.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS registro_procesos (
  id         BIGSERIAL PRIMARY KEY,
  proceso    TEXT NOT NULL,
  ok         BOOLEAN NOT NULL,
  resumen    JSONB,
  creado_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La consulta que se va a hacer siempre: "las últimas corridas de este proceso".
CREATE INDEX IF NOT EXISTS registro_procesos_proceso_fecha_idx
  ON registro_procesos (proceso, creado_at DESC);

-- ⚠ Sin datos personales adentro: acá van resúmenes técnicos (cuántos lotes, qué
--   motivo, cuánto tardó). Los nombres de lote que hoy trae el resumen de fallos
--   son el mínimo para poder ir a mirar el lote, y no salen de la cuenta del maker.
COMMENT ON TABLE registro_procesos IS
  'Rastro de los procesos que corren solos (cron/background), porque sus logs no llegan a netlify logs. Para mirar, no para archivar.';
COMMENT ON COLUMN registro_procesos.resumen IS
  'El JSON que se habría logueado. Recortado a 60 KB desde el codigo, DECLARANDO el recorte.';

-- ROLLBACK (comentado a proposito):
-- DROP TABLE IF EXISTS registro_procesos;
