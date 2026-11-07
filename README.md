# hn-colectores

Recolectores programados de HN AGRO (GitHub Actions). **Este repositorio sólo tiene los programas: no guarda ningún dato.**
Lo que bajan se guarda en un repositorio privado (permiso limitado a ese repositorio) y no se publica.

| Tarea | Cada cuánto | Fuente |
|---|---|---|
| colector-radar | cada hora | radares SINARAME (imágenes; uso interno, no se publican) |
| colector-inundacion | 2 veces por día | NASA LANCE (MODIS/VIIRS), con token de Earthdata |
| colector-smap | diario | NASA SMAP L4, con token de Earthdata |
| colector-lagunas | lunes | NASA SWOT (Hydrocron) |
| colector-imerg | diario | NASA IMERG-Late (lluvia satelital), con token de Earthdata |
| granizo-g3 | sólo a mano | NOAA GOES-16/19 ABI y GLM (buckets públicos); ver `granizo-g3/LEEME.md`. Salida: artefactos de la corrida |

Los registros de cada corrida muestran sólo cantidades.
