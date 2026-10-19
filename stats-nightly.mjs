// Fonction planifiée : chaque heure, mais ne travaille que de 17h à 5h (heure de Paris), plus un rattrapage à 11h.
// Netlify planifie en UTC : l'heure de Paris est vérifiée ici, donc le passage à l'heure d'hiver est géré tout seul.
import { runUpdate, parisHour, shouldRun } from '../lib/stats.mjs';

export default async () => {
  const h = parisHour();
  if(!shouldRun(h)) return new Response(`${h}h à Paris : pas de mise à jour à cette heure`, {headers:{'content-type':'text/plain; charset=utf-8'}});
  const log = await runUpdate({days: h === 11 ? 3 : 2});
  console.log(log.join('\n'));
  return new Response(log.join('\n'), {headers:{'content-type':'text/plain; charset=utf-8'}});
};

export const config = { schedule: '5 * * * *' };
