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
| vigia-satchi | cada 15 min (apagado hasta que la variable SATCHI_VIGIA_ON sea «si»; ver vigia/LEEME.md) | SATCHI público (crecidas y focos de calor): manda un mail si hay algo nuevo |
| granizo-archivo | cada 10 min (apagado hasta que la variable GRANIZO_ARCHIVO_ON sea «si»; ver granizo-archivo/PRENDER.md) | SATCHI público (granizo en vivo): cada barrido, entero, a una release diaria del repo privado |
| granizo-frescura | cada 20 min (con la misma variable) | el archivo de granizo: manda un mail si en 40 min no se guardó nada |

Los registros de cada corrida muestran sólo cantidades.
