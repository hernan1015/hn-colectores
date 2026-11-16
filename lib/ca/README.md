# lib/ca · la CA de Supabase para el TLS de los colectores (la 264)

Acá va **`supabase-prod-ca-2021.crt`**, la CA raíz **pública** que Supabase publica para verificar el TLS de su
Postgres (Dashboard → Project Settings → Database → SSL Configuration → «Download certificate»). **No es un secreto**:
va en el repo, una sola para todos los colectores (decisión de local, 16/11 05:33).

`lib/pg-tls.mjs` la lee y arma el `ssl` de postgres.js con `rejectUnauthorized: true`, esta CA y el nombre del host
de la URL. **Si el archivo no está, no se lee o no es una CA vigente, el colector NO se conecta** (error claro; nunca
cae a una conexión sin verificar).

## Estado

**Todavía no está.** pc-nanci no la encontró en el disco y no la baja de una fuente no oficial: la agrega local, bajada
del Dashboard del proyecto (la que se baja de ahí, no una copia de otro lado).

## Cómo agregarla (local)

1. Bajar `prod-ca-2021.crt` del Dashboard y guardarla como `lib/ca/supabase-prod-ca-2021.crt` (PEM, LF).
2. Mirarla:
   ```bash
   openssl x509 -in lib/ca/supabase-prod-ca-2021.crt -noout -subject -issuer -dates -ext basicConstraints -fingerprint -sha256
   ```
   Tiene que ser autofirmada (subject = issuer), con `CA:TRUE` y vigente.
3. Anotar la huella en `lib/ca/HUELLA-SHA256` (la línea `sha256 Fingerprint=AA:BB:…` tal cual). El test
   `lib/test/pg-tls.test.mjs` exige que la huella del archivo sea la anotada: cambiar la CA a escondidas da rojo.
4. Verificar que el pooler presenta un certificado firmado por ESA CA y a nombre de su host (ver `LISTO-264.md` del
   cortex, con el comando `openssl s_client` exacto).
5. Correr `npm test --prefix sipan-alto-valle` (ya no saltea «la CA común del repo»).

## Override opcional

Un colector puede pasar otra CA en texto (por ejemplo, un secreto `ZONA_PG_CA` en la 257) con
`conTls(url, opciones, { ca })`. Igual va con `rejectUnauthorized: true`. Lo normal es no usarlo.
