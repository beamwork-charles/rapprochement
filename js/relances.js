// Calendrier des relances (lecture seule à ce stade : rien n'est envoyé).
// Règles : BRIEF §8 et PDF §6-7.
//   Périmètre : factures ouvertes ou partiellement payées, échues depuis le 01/09/2026, reste dû ≥ 5 €.
//   Niveaux : 1 le jour de l'échéance, 2 à J+7, 3 à J+10, 4 à J+14, 5 trois jours ouvrés après le niveau 4 (opérationnels).
//   On envoie directement le niveau que justifie le retard (pas de rattrapage niveau par niveau) ; un seul suivi par client ;
//   envois à 8 h, jours ouvrés hors fériés français.
// Dates : chaînes AAAA-MM-JJ.

export const DEBUT_PERIMETRE = '2026-09-01';
export const RESTE_MINIMUM = 5;
/** Société qui facture : le 42 rue ND des Victoires est une société distincte des trois autres bâtiments. */
export const societeDe = (space) => (space === '42-rue-notre-dame-des-victoires' ? '42' : 'the-bureau');
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

// ---------------------------------------------------------------------------- textes
// Signature des emails (demande de Charles, 27/11/2026) : nom du service qui écrit + The Bureau (le logo est ajouté par la
// fonction d'envoi « email-client »). À l'envoi des relances (étape 7), ne pas l'ajouter deux fois : la fonction la pose déjà.
export const SERVICE_DEFAUT = 'Service comptabilité';
export const SERVICES = ['Service comptabilité', 'Service recouvrement', 'Service facturation'];
export const SIGNATURE = `${SERVICE_DEFAUT}\nThe Bureau`;
export const VARIABLES = ['client', 'factures', 'total', 'date_limite', 'historique', 'trame', 'signature'];
const eurTexte = (x) => {
  const [e, d] = Math.abs(x).toFixed(2).split('.');
  return (x < 0 ? '-' : '') + e.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + d + ' €';
};
const dateTexte = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const dateLongue = (d) => new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(d + 'T00:00:00Z'));

/**
 * Variables d'un email de relance pour un client.
 * @param client      entrée de calendrier().clients
 * @param dateEnvoi   date d'envoi (AAAA-MM-JJ) ; le délai du niveau 4 court sur 3 jours ouvrés
 * @param historique  [{ niveau, date }] relances déjà envoyées
 * @param trame       corps du modèle « ultime »
 */
export function variablesRelance(client, dateEnvoi, historique = [], trame = '') {
  return {
    client: client.client,
    factures: client.factures.map((f) => `• ${f.ref} · ${f.site} · échéance ${dateTexte(f.echeance)} · reste dû ${eurTexte(f.reste)}`).join('\n'),
    total: eurTexte(client.total),
    date_limite: dateLongue(ajouterOuvres(dateEnvoi, 3)),
    historique: historique.length ? historique.map((h) => `• Niveau ${h.niveau} envoyé le ${dateTexte(h.date)}`).join('\n') : '• aucune relance enregistrée',
    trame,
    signature: SIGNATURE,
  };
}
/** Remplace les {variables} ; une variable inconnue est laissée telle quelle pour être repérée à la relecture. */
export function rendreModele(texte, vars) {
  return String(texte).replace(/\{([a-z_]+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}
/** Code du modèle à utiliser pour un niveau donné. */
export const modelePour = (niveau, particulier) => (niveau === 4 && particulier ? 'niveau4_particulier' : niveau === 5 ? 'alerte5' : `niveau${niveau}`);

/** Niveau que justifierait le seul retard (sans tenir compte des relances déjà faites) — sert au constat. */
export function niveauSelonRetard(echeance, aujourdhui) {
  const j4 = ajouterJours(echeance, DECALAGE[4]);
  if (aujourdhui >= ajouterOuvres(j4, 3)) return 5;
  for (const n of [4, 3, 2, 1]) if (aujourdhui >= ajouterJours(echeance, DECALAGE[n])) return n;
  return 0;
}

/**
 * Prochaine relance (règle validée par Charles le 26/11/2026) : on envoie DIRECTEMENT le niveau que justifie le retard,
 * sans repasser par les niveaux précédents (un client à J+20 sans relance reçoit directement le niveau 4 ou 5).
 * Seule exception : après un niveau 4 envoyé, le niveau 5 attend les 3 jours ouvrés annoncés dans l'email.
 * @param echeance        date d'échéance (la plus ancienne du client)
 * @param atteint         dernier niveau envoyé (0 si aucun)
 * @param dateAtteint     date d'envoi du dernier niveau (ou null)
 * @param prochainEnvoi   premier créneau d'envoi possible (jour ouvré, 8 h)
 */
export function prochaineRelance(echeance, atteint, dateAtteint, prochainEnvoi) {
  if (atteint >= 5) return null;
  const delai4 = atteint === 4 && dateAtteint ? ajouterOuvres(dateAtteint, 3) : null; // « sans réponse sous 3 jours ouvrés »
  const niveauAu = (d) => {
    const n = niveauSelonRetard(echeance, d);
    return n === 5 && delai4 && d < delai4 ? 4 : n;
  };
  // dès le premier créneau si le retard justifie déjà un niveau supérieur au dernier envoyé
  const maintenant = niveauAu(prochainEnvoi);
  if (maintenant > atteint) return { niveau: maintenant, date: prochainEnvoi };
  // sinon : le jour où le retard atteint le niveau suivant
  const n = atteint + 1;
  let d = n === 5 ? dateNiveau5(echeance) : ajouterJours(echeance, DECALAGE[n]);
  if (delai4 && d < delai4) d = delai4;
  d = prochainOuvre(d);
  if (d < prochainEnvoi) d = prochainEnvoi;
  return { niveau: Math.max(n, niveauAu(d)), date: d };
}

/** Premier créneau d'envoi : aujourd'hui si jour ouvré et avant 8 h (heure de Paris), sinon le jour ouvré suivant. */
export function premierCreneau(maintenant = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(maintenant).map((x) => [x.type, x.value]));
  const auj = `${p.year}-${p.month}-${p.day}`;
  return { aujourdhui: auj, creneau: estOuvre(auj) && +p.hour < 8 ? auj : prochainOuvre(ajouterJours(auj, 1)) };
}

/** Date à laquelle une échéance atteint le niveau 5 (3 jours ouvrés après le niveau 4). */
export const dateNiveau5 = (echeance) => ajouterOuvres(ajouterJours(echeance, DECALAGE[4]), 3);

/**
 * Calendrier par client — UN seul suivi par client, tous bâtiments confondus (même group_uuid Archie) :
 * le niveau suit la facture en retard la plus ancienne et chaque email regroupe toutes ses factures en retard.
 * @param factures   factures Archie (ref, uuid, space, site, client, group_uuid, state, reste, echeance, type,
 *                   et pour le suivi : manager, manager_email, contacts, rappels_archie)
 * @param envoyees   relances déjà faites : [{ group_uuid, niveau, date, factures: [uuid] }]
 * @param exclus     { group_uuid: { motif } } (liste « ne pas relancer »)
 * @param avoirs     avoirs Archie encore disponibles : [{ uuid, ref, space, site, group_uuid, client, reste, date, origine }]
 */
export function calendrier(factures, envoyees, exclus, maintenant = new Date(), pasAvant = null, avoirs = []) {
  const premier = premierCreneau(maintenant);
  const aujourdhui = premier.aujourdhui;
  // verrou « aucun envoi avant le … » (paramètre relances_pas_avant) : le premier créneau ne peut pas être plus tôt
  const creneau = pasAvant && premier.creneau < pasAvant ? prochainOuvre(pasAvant) : premier.creneau;
  const histo = new Map(); // uuid facture -> { niveau, date }
  for (const r of envoyees) for (const u of r.factures || []) {
    const h = histo.get(u);
    if (!h || r.niveau > h.niveau) histo.set(u, { niveau: r.niveau, date: r.date });
  }
  const hors = { factures: 0, total: 0, sansEcheance: 0, totalSansEcheance: 0 };
  const lignes = [];
  for (const f of factures) {
    if (!['open', 'partially_paid'].includes(f.state)) continue;
    // une facture sans date d'échéance ne peut pas entrer au calendrier : on la compte pour qu'elle ne passe pas inaperçue
    if (!f.echeance) { if (f.reste >= RESTE_MINIMUM) { hors.sansEcheance++; hors.totalSansEcheance = Math.round((hors.totalSansEcheance + f.reste) * 100) / 100; } continue; }
    if (f.echeance > aujourdhui) continue;
    if (f.reste < RESTE_MINIMUM) continue;
    if (f.echeance < DEBUT_PERIMETRE) { hors.factures++; hors.total += f.reste; continue; }
    const h = histo.get(f.uuid) || { niveau: 0, date: null };
    lignes.push({
      ...f, retard: ecartJours(aujourdhui, f.echeance), niveau_atteint: h.niveau, date_atteint: h.date,
      niveau_retard: niveauSelonRetard(f.echeance, aujourdhui),
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
    c.factures.sort((a, b) => a.echeance.localeCompare(b.echeance) || (a.ref || '').localeCompare(b.ref || ''));
    c.total = Math.round(c.factures.reduce((s, f) => s + f.reste, 0) * 100) / 100;
    c.echeance_ref = c.factures[0].echeance; // la facture la plus ancienne mène le calendrier du client
    c.retard_max = c.factures[0].retard;
    // dernier niveau envoyé au client (pour l'une de ses factures encore en retard) et sa date
    c.niveau_atteint = 0; c.date_atteint = null;
    for (const f of c.factures) {
      if (f.niveau_atteint > c.niveau_atteint) { c.niveau_atteint = f.niveau_atteint; c.date_atteint = f.date_atteint; }
      else if (f.niveau_atteint && f.niveau_atteint === c.niveau_atteint && f.date_atteint > (c.date_atteint || '')) c.date_atteint = f.date_atteint;
    }
    c.niveau_retard = niveauSelonRetard(c.echeance_ref, aujourdhui);
    const p = prochaineRelance(c.echeance_ref, c.niveau_atteint, c.date_atteint, creneau);
    c.prochaine_date = p ? p.date : null;
    c.prochain_niveau = p ? p.niveau : null;
    for (const f of c.factures) f.prochaine = p; // un seul email pour toutes les factures du client
    c.date_niveau5 = c.niveau_atteint >= 5 ? c.date_atteint : dateNiveau5(c.echeance_ref);
    c.sites = [...new Set(c.factures.map((f) => f.site).filter(Boolean))];
    // suivi : contact et relances déjà faites (outil + Archie, en jours distincts)
    const lisible = (e) => e && !e.includes('*'); // Archie masque l'email du responsable (« a******@… ») : inutilisable
    c.manager = c.factures.map((f) => f.manager).find(Boolean) || '';
    c.manager_email = c.factures.map((f) => f.manager_email).find(lisible) || '';
    // Destinataires des relances = contacts de FACTURATION uniquement (adresses « recipients » de la facture et destinataires
    // de facturation du client dans Archie) — jamais les autres membres de la société. Le responsable n'en fait partie que
    // s'il figure lui-même parmi ces adresses ; sinon il est seulement affiché (manager_email), sans recevoir de relance.
    c.contacts = [...new Set(c.factures.flatMap((f) => f.contacts || []))].filter(lisible);
    // Avoirs encore disponibles pour ce client (tous bâtiments) ; seuls ceux de la même société que les factures peuvent les solder.
    c.avoirs = c.group_uuid ? avoirs.filter((a) => a.group_uuid === c.group_uuid && a.reste > 0.005).sort((a, b) => (a.date || '').localeCompare(b.date || '')) : [];
    c.total_avoirs = Math.round(c.avoirs.reduce((s, a) => s + a.reste, 0) * 100) / 100;
    let couvert = 0;
    for (const soc of new Set(c.factures.map((f) => societeDe(f.space)))) {
      const du = c.factures.filter((f) => societeDe(f.space) === soc).reduce((s, f) => s + f.reste, 0);
      const dispo = c.avoirs.filter((a) => societeDe(a.space) === soc).reduce((s, a) => s + a.reste, 0);
      couvert += Math.min(du, dispo);
    }
    c.avoirs_imputables = Math.round(couvert * 100) / 100;
    c.couverture = c.avoirs_imputables >= c.total - 0.01 && c.total > 0 ? 'totale' : c.avoirs_imputables > 0.005 ? 'partielle' : null;
    const uuids = new Set(c.factures.map((f) => f.uuid));
    const jours = new Set(c.factures.flatMap((f) => f.rappels_archie || []));
    for (const r of envoyees) if ((r.factures || []).some((u) => uuids.has(u))) jours.add(r.date);
    c.relances = [...jours].sort();
    c.exclu = c.group_uuid ? exclus[c.group_uuid] || null : null;
    return c;
  }).sort((a, b) => b.retard_max - a.retard_max || b.total - a.total);
  hors.total = Math.round(hors.total * 100) / 100;
  return { aujourdhui, creneau, clients, hors };
}
