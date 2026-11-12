# opera-mosaico · el mosaico diario de OPERA DSWx-S1, solo (DISEÑO: APAGADO)

**Qué hace:** cada noche (04:10 UTC) arma las fechas de los últimos días que cambiaron en la NASA y las suma a `satchi-mapas/opera/cog/` sin pisar la historia. Así el «AGUA RADAR» de SATCHI (`_v1117`) no depende de una corrida a mano.

**Archivos**
- `opera-mosaico-diario.workflow.yml.txt`: el workflow. Va en `.github/workflows/opera-mosaico-diario.yml`. Está apagado: el `schedule` va comentado y el job tiene `if: false`.
- `fusionar.mjs`: lo que les falta a los scripts de hn-agro (`tools/satchi/cog/`) para trabajar de a un día:
  - `decidir`: qué fechas se re-arman;
  - `fusionar`: arma el catálogo completo, el de subida y `latest`;
  - `indice`: arma `pasadas.json`, conservando la cobertura medida de las fechas que no se tocaron;
  - `bajar` / `subir-indice`: GET y PUT con la llave del entorno.
- `test/fusionar.test.mjs`: `node --test opera-mosaico/test/fusionar.test.mjs` (6 tests). Control negativo: `OPERA_DIARIO_MUTAR=indice` (el índice pisa la historia) u `OPERA_DIARIO_MUTAR=conservar` (se re-arma aunque falten pasadas) dan rojo.

**Secretos**
- `EARTHDATA_TOKEN`: ya está.
- `HN_AGRO_LECTURA`: sólo lectura de hn-agro.
- `R2_OPERA_CUENTA`, `R2_OPERA_ACCESS_KEY_ID` y `R2_OPERA_SECRET_ACCESS_KEY`: lectura y escritura sólo en `satchi-mapas`.

Los carga local.

**Para prenderlo** (con el OK; lo hace local):
1. copiar el workflow a `.github/workflows/`;
2. correrlo a mano en seco (`subir: false`);
3. correrlo a mano con `subir: true`;
4. descomentar el `schedule` y sacar el `if: false`.

**La red de seguridad:** el vigía de frescura (`vigia/opera-frescura.workflow.yml.txt`, rama `feat/opera-frescura`) avisa si el índice público pasa más de 3 días sin una fecha nueva.

Diseño, costo y alternativas: hn-cortex `docs/opera-mosaicos-2026-11-11/AUTOMATICO.md`.
