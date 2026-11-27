// Données du calendrier des relances, communes à l'écran principal et à la page de suivi « niveau 5 ».
// Le calcul lui-même est dans relances.js (même règle partout).
import * as RL from './relances.js?v=20261127-3';

export const SPACES = ['16-cours-albert-1er', '25-rue-du-4-septembre', '28-cours-albert-1er', '42-rue-notre-dame-des-victoires'];
const dateParis = (q) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(q));

// ---------------------------------------------------------------------------- estimation du temps restant
const memo = { lire(k, d) { try { const v = Number(localStorage.getItem(k)); return v > 0 ? v : d; } catch { return d; } },
  ecrire(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* stockage indisponible */ } } };
export const memoire = memo;
export function duree(s) {
  s = Math.max(0, Math.round(s));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}
/**
 * Temps restant estimé d'après l'avancement (fait / total) depuis `debut` ; avant le premier pas, d'après `parPas` secondes par pas.
 * Renvoie « environ 25 s restantes », « quelques secondes »…
 */
export function estimation(debut, fait, total, parPas = 1) {
  const ecoule = (Date.now() - debut) / 1000;
  if (fait >= total) return 'quelques secondes';
  // mélange de la durée habituelle (parPas, mesurée la fois précédente) et du rythme observé, qui l'emporte peu à peu
  const prevu = total * parPas;
  const observe = fait > 0 ? (ecoule / fait) * total : prevu;
  const w = Math.min(1, fait / total);
  const reste = Math.max(0, (1 - w) * prevu + w * observe - ecoule);
  return reste < 4 ? 'quelques secondes' : `environ ${duree(reste)} restantes`;
}

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

/** Relances déjà envoyées, liste « ne pas relancer », activation des envois, dernier relevé déposé. */
export async function contexte(sb) {
  const [env, npr, rel, par] = await Promise.all([
    toutLire(() => sb.from('relances').select('group_uuid,niveau,quand,factures').eq('statut', 'envoye').order('id')),
    toutLire(() => sb.from('ne_pas_relancer').select('group_uuid,client,motif,par_email,quand').order('group_uuid')),
    // Garde-fou « relances suspendues si aucun relevé traité depuis 2 jours ouvrés » : on compte depuis le DÉPÔT du dernier
    // relevé (un vieux relevé simplement rouvert et réanalysé ce matin ne doit pas lever la suspension).
    sb.from('releves').select('depose_le').neq('statut', 'erreur').order('depose_le', { ascending: false }).limit(1),
    sb.from('parametres').select('cle,valeur'),
  ]);
  return {
    envoyees: env.map((r) => ({ group_uuid: r.group_uuid, niveau: r.niveau, date: dateParis(r.quand), factures: (r.factures || []).map((f) => f.uuid || f) })),
    exclus: Object.fromEntries(npr.map((n) => [n.group_uuid, n])),
    dernierReleve: rel.data?.[0]?.depose_le ? dateParis(rel.data[0].depose_le) : null,
    actives: (par.data || []).find((p) => p.cle === 'relances_actives')?.valeur === true,
    // verrou : aucun envoi avant cette date (AAAA-MM-JJ), quel que soit l'état d'activation
    pasAvant: (() => { const v = (par.data || []).find((p) => p.cle === 'relances_pas_avant')?.valeur; return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null; })(),
  };
}

/** Calendrier complet à partir des factures ouvertes. */
export function calculer(factures, ctx, calcule_le = new Date()) {
  const R = RL.calendrier(factures, ctx.envoyees, ctx.exclus, new Date(), ctx.pasAvant);
  R.pasAvant = ctx.pasAvant && ctx.pasAvant > R.aujourdhui ? ctx.pasAvant : null;
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

/**
 * Relit dans Archie les factures ouvertes des 4 bâtiments (en parallèle). `appel(nom, corps)` appelle une fonction Supabase.
 * `progression(texte)` reçoit l'avancement avec une estimation du temps restant (d'après la durée de la lecture précédente).
 */
export async function lireOuvertes(appel, progression = () => {}) {
  let lots = 0, finis = 0;
  const debut = Date.now(), attendus = memo.lire('lots_ouvertes', 8), parLot = memo.lire('sec_par_lot_ouvertes', 1.5);
  const maj = () => progression(`Lecture d'Archie : ${finis}/${SPACES.length} bâtiments · ${estimation(debut, Math.min(lots, attendus - 0.5), attendus, parLot)}`);
  maj();
  const tic = setInterval(maj, 1000); // le compte à rebours avance chaque seconde
  const parBatiment = await Promise.all(SPACES.map(async (space) => {
    const out = []; let curseur = null;
    do {
      const r = await appel('archie-donnees', { space, quoi: 'ouvertes', since: RL.DEBUT_PERIMETRE, curseur });
      out.push(...r.items); curseur = r.curseur;
      lots++; maj();
    } while (curseur);
    finis++; maj();
    return out;
  })).finally(() => clearInterval(tic));
  memo.ecrire('lots_ouvertes', lots);
  memo.ecrire('sec_par_lot_ouvertes', ((Date.now() - debut) / 1000 / Math.max(1, lots)).toFixed(2));
  return parBatiment.flat();
}
