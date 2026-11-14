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
| colector-sipan-alto-valle | cada 6 h (apagado hasta SIPAN_ON=si; ver sipan-alto-valle/LEEME.md) | red agrometeorológica del INTA EEA Alto Valle (uso interno; los datos van a la base y a R2 privado) |
| medicion-heladas-sipan | diario 09:41 AR (apagado hasta SIPAN_ON=si) | pronóstico de mínima de SATCHI (Open-Meteo) contra la noche observada en el SIPAN |
| vigia-satchi | cada 15 min (apagado hasta que la variable SATCHI_VIGIA_ON sea «si»; ver vigia/LEEME.md) | SATCHI público (crecidas y focos de calor): manda un mail si hay algo nuevo |
| granizo-archivo | cada 10 min (apagado hasta que la variable GRANIZO_ARCHIVO_ON sea «si»; ver granizo-archivo/PRENDER.md) | SATCHI público (granizo en vivo): cada barrido, entero, a una release diaria del repo privado |
| granizo-frescura | cada 20 min (con la misma variable) | el archivo de granizo: manda un mail si en 40 min no se guardó nada |

Los registros de cada corrida muestran sólo cantidades.
