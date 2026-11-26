// Données du calendrier des relances, communes à l'écran principal et à la page de suivi « niveau 5 ».
// Le calcul lui-même est dans relances.js (même règle partout).
import * as RL from './relances.js?v=20261126-10';

export const SPACES = ['16-cours-albert-1er', '25-rue-du-4-septembre', '28-cours-albert-1er', '42-rue-notre-dame-des-victoires'];
const dateParis = (q) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(q));

/** Lit toutes les lignes d'une requête (l'API limite à 1000 lignes par appel). */
export async function toutLire(fabrique) {
  const out = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await fabrique().range(de, de + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

/** Relances déjà envoyées, liste « ne pas relancer », activation des envois, dernier relevé analysé. */
export async function contexte(sb) {
  const [env, npr, rel, par] = await Promise.all([
    toutLire(() => sb.from('relances').select('group_uuid,niveau,quand,factures').eq('statut', 'envoye').order('id')),
    toutLire(() => sb.from('ne_pas_relancer').select('group_uuid,client,motif,par_email,quand').order('group_uuid')),
    sb.from('releves').select('analyse_le').not('analyse_le', 'is', null).order('analyse_le', { ascending: false }).limit(1),
    sb.from('parametres').select('cle,valeur'),
  ]);
  return {
    envoyees: env.map((r) => ({ group_uuid: r.group_uuid, niveau: r.niveau, date: dateParis(r.quand), factures: (r.factures || []).map((f) => f.uuid || f) })),
    exclus: Object.fromEntries(npr.map((n) => [n.group_uuid, n])),
    dernierReleve: rel.data?.[0]?.analyse_le ? dateParis(rel.data[0].analyse_le) : null,
    actives: (par.data || []).find((p) => p.cle === 'relances_actives')?.valeur === true,
  };
}

/** Calendrier complet à partir des factures ouvertes. */
export function calculer(factures, ctx, calcule_le = new Date()) {
  const R = RL.calendrier(factures, ctx.envoyees, ctx.exclus);
  R.dernierReleve = ctx.dernierReleve;
  R.suspendues = !R.dernierReleve || RL.ouvresEntre(R.dernierReleve, R.aujourdhui) > 2;
  R.actives = ctx.actives;
  R.calcule_le = calcule_le;
  return R;
}

/** Clients au niveau 5 : alerte envoyée une fois les relances activées ; avant, d'après le seul retard. */
export const niveau5 = (R) => R.clients.filter((c) => !c.exclu && (R.actives ? c.niveau_atteint >= 5 : c.niveau_retard >= 5));

/** Remplace le calendrier enregistré (export Excel, page de suivi), en une seule transaction. */
export async function enregistrer(sb, R) {
  const lignes = R.clients.flatMap((c) => c.factures.map((f) => ({
    group_uuid: c.group_uuid, client: c.client, particulier: c.particulier, exclu: Boolean(c.exclu), motif_exclusion: c.exclu?.motif || null,
    facture_uuid: f.uuid, facture_ref: f.ref, space: f.space, site: f.site, echeance: f.echeance, reste: f.reste, retard: f.retard,
    niveau_atteint: f.niveau_atteint, niveau_selon_retard: f.niveau_retard,
    prochain_niveau: c.exclu ? null : c.prochain_niveau, prochaine_date: c.exclu ? null : c.prochaine_date,
    manager: f.manager || null, manager_email: f.manager_email || null, contacts: f.contacts || [], rappels_archie: f.rappels_archie || [],
  })));
  const { error } = await sb.rpc('remplacer_relances_suivi', { lignes });
  if (error) throw new Error(error.message);
}

/** Factures du dernier calendrier enregistré, pour un affichage immédiat sans lire Archie. */
export async function lireEnregistre(sb) {
  const rows = await toutLire(() => sb.from('relances_suivi').select('*').order('id'));
  const vues = new Map();
  for (const r of rows) vues.set(r.facture_uuid, r); // par sécurité : une seule ligne par facture
  const lignes = [...vues.values()];
  return {
    calcule_le: lignes.length ? new Date(lignes.map((r) => r.calcule_le).sort().pop()) : null,
    factures: lignes.map((r) => ({
      uuid: r.facture_uuid, ref: r.facture_ref, space: r.space, site: r.site, client: r.client, group_uuid: r.group_uuid,
      state: 'open', reste: Number(r.reste), echeance: r.echeance, type: r.particulier ? 'user' : 'group',
      manager: r.manager || '', manager_email: r.manager_email || '', contacts: r.contacts || [], rappels_archie: r.rappels_archie || [],
    })),
  };
}

/** Relit dans Archie les factures ouvertes des 4 bâtiments (en parallèle). `appel(nom, corps)` appelle une fonction Supabase. */
export async function lireOuvertes(appel, progression = () => {}) {
  let lots = 0, finis = 0;
  const parBatiment = await Promise.all(SPACES.map(async (space) => {
    const out = []; let curseur = null;
    do {
      const r = await appel('archie-donnees', { space, quoi: 'ouvertes', since: RL.DEBUT_PERIMETRE, curseur });
      out.push(...r.items); curseur = r.curseur;
      lots++; progression(finis, lots);
    } while (curseur);
    finis++; progression(finis, lots);
    return out;
  }));
  return parBatiment.flat();
}
