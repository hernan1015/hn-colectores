// HN AGRO · PROPUESTA (sin activar) · disparo horario del colector del radar desde un Cloudflare Worker.
// El cron de GitHub en hn-colectores sale 2-7 veces por día (atraso mediano de 5,5 h en este repo), y el sitio
// guarda ~5,5 h: se pierde un tercio de los frames. Este Worker pide cada hora un workflow_dispatch de
// colector.yml (el mismo colectar.sh y la misma ventana de 240 min; el cron actual queda de respaldo).
// Secreto que hace falta (NO creado): GH_DISPATCH_TOKEN = token fine-grained con acceso SOLO a
// hernan1015/hn-colectores y permiso «Actions: Read and write» (nada de Contents). Se carga con
// `wrangler secret put GH_DISPATCH_TOKEN`.
// Plan gratis de Workers: 5 cron triggers por cuenta, 100.000 pedidos por día, 10 ms de CPU por invocación
// (la espera del fetch no cuenta como CPU). Esto usa 1 trigger y 24 pedidos por día.
const URL_DISPATCH =
  "https://api.github.com/repos/hernan1015/hn-colectores/actions/workflows/colector.yml/dispatches";

async function disparar(env) {
  const r = await fetch(URL_DISPATCH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "HN-AGRO disparo-radar (contacto: info@hninge.com)",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // 204 = aceptado. Cualquier otra cosa queda en el log del Worker (no reintenta: la ventana de 240 min
  // del colector cubre hasta 3 disparos perdidos seguidos).
  if (r.status !== 204) console.log(`dispatch ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(disparar(env));
  },
};
