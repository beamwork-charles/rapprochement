// Calendrier des relances (lecture seule à ce stade : rien n'est envoyé).
// Règles : BRIEF §8 et PDF §6-7.
//   Périmètre : factures ouvertes ou partiellement payées, échues depuis le 01/09/2026, reste dû ≥ 5 €.
//   Niveaux : 1 le jour de l'échéance, 2 à J+7, 3 à J+10, 4 à J+14, 5 trois jours ouvrés après le niveau 4 (opérationnels).
//   Un niveau n'est envoyé que si le précédent l'a été ; envois à 8 h, jours ouvrés hors fériés français.
// Dates : chaînes AAAA-MM-JJ.

export const DEBUT_PERIMETRE = '2026-09-01';
export const RESTE_MINIMUM = 5;
export const DECALAGE = { 1: 0, 2: 7, 3: 10, 4: 14 }; // jours calendaires après l'échéance
export const LIBELLE_NIVEAU = { 1: 'Rappel courtois', 2: 'Relance simple', 3: 'Relance ferme', 4: 'Avertissement frais 40 €', 5: 'Opérationnels (ultime relance)' };

const dn = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
const iso = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
export const ajouterJours = (d, n) => iso(dn(d) + n);
export const ecartJours = (a, b) => dn(a) - dn(b);

function paques(annee) { // algorithme de Meeus/Jones/Butcher
  const a = annee % 19, b = Math.floor(annee / 100), c = annee % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31), jour = ((h + l - 7 * m + 114) % 31) + 1;
  return `${annee}-${String(mois).padStart(2, '0')}-${String(jour).padStart(2, '0')}`;
}
const cacheFeries = new Map();
export function feries(annee) {
  if (!cacheFeries.has(annee)) {
    const p = paques(annee);
    cacheFeries.set(annee, new Set([
      `${annee}-01-01`, ajouterJours(p, 1), `${annee}-05-01`, `${annee}-05-08`, ajouterJours(p, 39), ajouterJours(p, 50),
      `${annee}-07-14`, `${annee}-08-15`, `${annee}-11-01`, `${annee}-11-11`, `${annee}-12-25`,
    ]));
  }
  return cacheFeries.get(annee);
}
export function estOuvre(d) {
  const jour = new Date(dn(d) * 86400000).getUTCDay();
  return jour !== 0 && jour !== 6 && !feries(+d.slice(0, 4)).has(d);
}
/** Premier jour ouvré ≥ d. */
export function prochainOuvre(d) { while (!estOuvre(d)) d = ajouterJours(d, 1); return d; }
/** d + n jours ouvrés. */
export function ajouterOuvres(d, n) { while (n > 0) { d = ajouterJours(d, 1); if (estOuvre(d)) n--; } return d; }
/** Jours ouvrés écoulés strictement après a jusqu'à b inclus. */
export function ouvresEntre(a, b) { let n = 0; for (let d = ajouterJours(a, 1); d <= b; d = ajouterJours(d, 1)) if (estOuvre(d)) n++; return n; }

/** Niveau que justifierait le seul retard (sans tenir compte des relances déjà faites) — sert au constat. */
export function niveauSelonRetard(echeance, aujourdhui) {
  const j4 = ajouterJours(echeance, DECALAGE[4]);
  if (aujourdhui >= ajouterOuvres(j4, 3)) return 5;
  for (const n of [4, 3, 2, 1]) if (aujourdhui >= ajouterJours(echeance, DECALAGE[n])) return n;
  return 0;
}

/**
 * Prochaine relance d'une facture.
 * @param echeance        date d'échéance
 * @param atteint         dernier niveau envoyé (0 si aucun)
 * @param dateAtteint     date d'envoi du dernier niveau (ou null)
 * @param prochainEnvoi   premier créneau d'envoi possible (jour ouvré, 8 h)
 * Un niveau n'est envoyé que si le précédent l'a été : en rattrapage, l'écart entre deux niveaux est au moins
 * celui du calendrier normal (7, 3, 4 jours ; 3 jours ouvrés avant le niveau 5).
 */
export function prochaineRelance(echeance, atteint, dateAtteint, prochainEnvoi) {
  if (atteint >= 5) return null;
  const n = atteint + 1;
  let d;
  if (n === 5) d = ajouterOuvres(dateAtteint || ajouterJours(echeance, DECALAGE[4]), 3);
  else {
    d = ajouterJours(echeance, DECALAGE[n]);
    if (atteint > 0 && dateAtteint) d = [d, ajouterJours(dateAtteint, DECALAGE[n] - DECALAGE[atteint])].sort().pop();
  }
  d = prochainOuvre(d);
  if (d < prochainEnvoi) d = prochainEnvoi;
  return { niveau: n, date: d };
}

/** Premier créneau d'envoi : aujourd'hui si jour ouvré et avant 8 h (heure de Paris), sinon le jour ouvré suivant. */
export function premierCreneau(maintenant = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(maintenant).map((x) => [x.type, x.value]));
  const auj = `${p.year}-${p.month}-${p.day}`;
  return { aujourdhui: auj, creneau: estOuvre(auj) && +p.hour < 8 ? auj : prochainOuvre(ajouterJours(auj, 1)) };
}

/**
 * Calendrier par client.
 * @param factures   factures Archie (ref, uuid, space, site, client, group_uuid, state, reste, echeance, type)
 * @param envoyees   relances déjà faites : [{ group_uuid, niveau, date, factures: [uuid] }]
 * @param exclus     { group_uuid: { motif } } (liste « ne pas relancer »)
 */
export function calendrier(factures, envoyees, exclus, maintenant = new Date()) {
  const { aujourdhui, creneau } = premierCreneau(maintenant);
  const histo = new Map(); // uuid facture -> { niveau, date }
  for (const r of envoyees) for (const u of r.factures || []) {
    const h = histo.get(u);
    if (!h || r.niveau > h.niveau) histo.set(u, { niveau: r.niveau, date: r.date });
  }
  const hors = { factures: 0, total: 0 };
  const lignes = [];
  for (const f of factures) {
    if (!['open', 'partially_paid'].includes(f.state) || !f.echeance || f.echeance > aujourdhui) continue;
    if (f.reste < RESTE_MINIMUM) continue;
    if (f.echeance < DEBUT_PERIMETRE) { hors.factures++; hors.total += f.reste; continue; }
    const h = histo.get(f.uuid) || { niveau: 0, date: null };
    lignes.push({
      ...f, retard: ecartJours(aujourdhui, f.echeance), niveau_atteint: h.niveau, date_atteint: h.date,
      niveau_retard: niveauSelonRetard(f.echeance, aujourdhui), prochaine: prochaineRelance(f.echeance, h.niveau, h.date, creneau),
    });
  }
  const parClient = new Map();
  for (const l of lignes) {
    const k = l.group_uuid || 'sans-client:' + l.client;
    if (!parClient.has(k)) parClient.set(k, { cle: k, group_uuid: l.group_uuid, client: l.client, particulier: false, factures: [] });
    const c = parClient.get(k);
    c.factures.push(l);
    if (l.type === 'user') c.particulier = true;
  }
  const clients = [...parClient.values()].map((c) => {
    c.factures.sort((a, b) => a.echeance.localeCompare(b.echeance));
    c.total = Math.round(c.factures.reduce((s, f) => s + f.reste, 0) * 100) / 100;
    c.retard_max = Math.max(...c.factures.map((f) => f.retard));
    c.niveau_atteint = Math.max(...c.factures.map((f) => f.niveau_atteint));
    const proch = c.factures.map((f) => f.prochaine).filter(Boolean);
    c.prochaine_date = proch.length ? proch.map((p) => p.date).sort()[0] : null;
    c.prochain_niveau = proch.length ? Math.max(...proch.filter((p) => p.date === c.prochaine_date).map((p) => p.niveau)) : null;
    c.exclu = c.group_uuid ? exclus[c.group_uuid] || null : null;
    return c;
  }).sort((a, b) => b.retard_max - a.retard_max || b.total - a.total);
  hors.total = Math.round(hors.total * 100) / 100;
  return { aujourdhui, creneau, clients, hors };
}
