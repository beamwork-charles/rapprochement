// Calcul de l'occupation des 4 bâtiments à partir des données Archie compactées par la fonction « tableau » :
// espaces (bureaux avec surface, postes, étage), abonnements (client, dates, prix, espaces rattachés) et forfaits (prix catalogue).
// Fonctions pures, sans accès réseau : le résultat est affiché par tableau.js et enregistré comme instantané.

export const BATIMENTS = [
  { space: '28-cours-albert-1er', code: 'TB1', nom: '28 Cours Albert 1er' },
  { space: '16-cours-albert-1er', code: 'TB2', nom: '16 Cours Albert 1er' },
  { space: '25-rue-du-4-septembre', code: 'TB3', nom: '25 rue du 4 Septembre' },
  { space: '42-rue-notre-dame-des-victoires', code: 'TB4', nom: '42 rue Notre-Dame-des-Victoires' },
];
export const CATEGORIES = [
  ['bureaux', 'Bureaux'], ['coresidents', 'Co-résidents'], ['itinerants', 'Itinérants'],
  ['parking', 'Parking'], ['domiciliation', 'Domiciliation'], ['autres', 'Autres abonnements'],
];
export const HORIZON_JOURS = 90; // « à venir » : départs et arrivées dans les 90 jours
export const REGLE_OCC = 3; // version du calcul (2 : statuts de la feuille DATA du classeur ; 3 : espaces hors bureaux exclus, 27/11/2026) ; un instantané plus ancien est recalculé
/** Espaces « office » d'Archie qui ne sont pas des bureaux à louer (absents du classeur « TB - The Bureau ») : exclus de l'occupation.
 *  A304 : Boardroom (salle de réunion) ; A000 : rez-de-chaussée de TB1 ; C215 : salle de réunion ; D400 : 4e étage de TB4 entier, déjà compté bureau par bureau. */
export const HORS_BUREAUX = { TB1: ['A304', 'A000'], TB3: ['C215'], TB4: ['D400'] };

const norm = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, '');
const arrondi = (x) => Math.round(x * 100) / 100;
export const ajouterJours = (iso, n) => new Date(Date.parse(iso + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);

/** Codes de bureau cités dans un nom de forfait, plages comprises : « C101 à C106 », « A101-A107 », « B207/208 ». */
export function codes(nom) {
  const s = String(nom ?? '').toUpperCase().replace(/\s+/g, ' ');
  const out = new Set();
  const re = /([A-D])\s?(\d{3})([A-Z]?)(?:\s*(?:-|À|A|AU|\/)\s*([A-D])?\s?(\d{3}))?/g;
  let m;
  while ((m = re.exec(s))) {
    const L = m[1], a = Number(m[2]);
    if (m[5]) { const b = Number(m[5]); if (b >= a && b - a <= 20) { for (let n = a; n <= b; n++) out.add(L + n); continue; } }
    out.add(L + m[2]);
  }
  return [...out];
}

/** Catégorie d'un abonnement d'après le nom de son forfait (et ses bureaux rattachés). */
export function categorie(a, aDesBureaux) {
  const n = String(a.nom ?? '').toLowerCase();
  if (/casier|t[ée]l[ée]travail|directory|baie|courrier|scan/.test(n)) return 'autres';
  if (/co-?r[ée]sident/.test(n)) return 'coresidents';
  if (/itin[ée]rant/.test(n) && !/casier/.test(n)) return 'itinerants';
  if (/parking/.test(n)) return 'parking';
  if (/domicil/.test(n)) return 'domiciliation';
  if (aDesBureaux || /r[ée]sident|plateau/.test(n)) return 'bureaux';
  return 'autres';
}

/** Date de fin effective (fin de contrat ou annulation, la plus proche). */
const finEffective = (a) => [a.fin, a.annulation].filter(Boolean).sort()[0] || null;
const actifLe = (a, d) => (!a.debut || a.debut <= d) && (!finEffective(a) || finEffective(a) >= d);
const loyer = (a) => Number(a.prix_remise ?? a.prix ?? 0);

/**
 * @param D { espaces, abonnements, forfaits } tels que renvoyés par occupation_lot
 * @param aujourdhui 'AAAA-MM-JJ' (heure de Paris)
 */
export function calculer(D, aujourdhui) {
  const horizon = ajouterJours(aujourdhui, HORIZON_JOURS);
  const mois = aujourdhui.slice(0, 7);
  const espaces = new Map(D.espaces.map((e) => [e.uuid, e]));
  // bureaux : espaces « office » d'Archie, hors postes de co-résident (comptés avec les co-résidents) et hors salles ou étages entiers (HORS_BUREAUX)
  const exclus = new Set(BATIMENTS.flatMap((B) => (HORS_BUREAUX[B.code] || []).map((n) => B.space + '|' + norm(n))));
  const bureaux = D.espaces.filter((e) => e.categorie === 'office' && !e.archive && !/^co-?r[ée]sident/i.test(e.nom) && !exclus.has(e.space + '|' + norm(e.nom)));
  // bureaux par bâtiment et par nom normalisé (« B505 - B506 » → « B505-B506 »)
  const parNom = new Map(bureaux.map((b) => [b.space + '|' + norm(b.nom), b]));
  const prixForfait = new Map(D.forfaits.filter((f) => f.prix != null).map((f) => [f.space + '|' + norm(f.nom), f.prix]));
  // forfaits de lot (« Résident C101 à C106 », « Résident A101-A107 ») : prix réparti entre les bureaux selon leur surface
  const prixLot = new Map();
  for (const f of D.forfaits) {
    if (f.prix == null || f.archive || !/^\s*(r[ée]sident|plateau|bureau)\b/i.test(f.nom)) continue;
    const lot = codes(f.nom).map((c) => parNom.get(f.space + '|' + c)).filter(Boolean);
    if (lot.length < 2) continue;
    const surf = lot.reduce((s, b) => s + (b.surface || 0), 0);
    for (const b of lot) if (!prixLot.has(b.uuid)) prixLot.set(b.uuid, arrondi(surf > 0 ? f.prix * (b.surface || 0) / surf : f.prix / lot.length));
  }
  const prixCatalogue = (b) => ['Résident ', 'Plateau ', 'Bureau ', ''].map((p) => prixForfait.get(b.space + '|' + norm(p + b.nom))).find((x) => x != null)
    ?? prixLot.get(b.uuid) ?? null;

  /** Bureaux d'un abonnement : espaces rattachés dans Archie, sinon codes lus dans le nom du forfait. */
  function bureauxDe(a) {
    const z = a.zones.map((u) => espaces.get(u)).filter((e) => e && e.categorie === 'office' && !e.archive && !exclus.has(e.space + '|' + norm(e.nom)));
    if (z.length) return z;
    // par le nom : seulement les forfaits de bureau (« Résident A301 », « Plateau A110 »), pas « Fontaine à eau A110 »
    if (a.type !== 'plan' || !/^\s*(r[ée]sident|plateau|bureau)\b/i.test(a.nom) || /co-?r[ée]s/i.test(a.nom)) return [];
    const suffixe = norm(String(a.nom).replace(/^\s*(r[ée]sident|plateau)\s*/i, ''));
    if (parNom.has(a.space + '|' + suffixe)) return [parNom.get(a.space + '|' + suffixe)];
    const out = new Set();
    for (const c of codes(a.nom)) {
      if (parNom.has(a.space + '|' + c)) out.add(parNom.get(a.space + '|' + c));
      else for (const b of bureaux) if (b.space === a.space && new RegExp('^' + c + '[A-Z]$').test(norm(b.nom))) out.add(b); // C308 → C308A, C308B
    }
    return [...out];
  }

  const lies = new Map(); // uuid bureau → abonnements rattachés
  const abos = D.abonnements.map((a) => {
    const bs = bureauxDe(a);
    const x = { ...a, bureaux: bs.map((b) => b.uuid), cat: categorie(a, bs.length > 0) };
    for (const b of bs) { if (!lies.has(b.uuid)) lies.set(b.uuid, []); lies.get(b.uuid).push(x); }
    return x;
  });

  // ------------------------------------------------------------------ bureaux, un par ligne
  const unites = bureaux.map((b) => {
    const L = lies.get(b.uuid) || [];
    // contrat principal : le loyer le plus élevé (une option rattachée au même bureau ne doit pas le masquer)
    const actuels = L.filter((a) => actifLe(a, aujourdhui)).sort((x, y) => loyer(y) - loyer(x));
    const futurs = L.filter((a) => a.debut && a.debut > aujourdhui).sort((x, y) => x.debut.localeCompare(y.debut));
    const occ = actuels[0] || null;
    const prixGrille = prixCatalogue(b) ?? (occ && occ.bureaux.length === 1 ? occ.prix_catalogue : null) ?? null;
    // part du loyer de l'abonnement attribuée à ce bureau (au prorata des surfaces quand il couvre plusieurs bureaux)
    const part = (a) => {
      if (!a) return null;
      if (a.bureaux.length <= 1) return loyer(a);
      const lot = a.bureaux.map((u) => espaces.get(u)).filter(Boolean);
      const total = lot.reduce((s, x) => s + (x.surface || 0), 0);
      return total > 0 ? arrondi(loyer(a) * (b.surface || 0) / total) : arrondi(loyer(a) / a.bureaux.length);
    };
    let statut = 'libre', date = null;
    const finOcc = occ ? finEffective(occ) : null;
    const suivant = futurs[0] || null;
    // même règle que la feuille DATA du classeur « TB - The Bureau » : sans limite de date,
    // « sur le départ » dès qu'une fin est connue sans successeur le lendemain, « signé » dès qu'un contrat est à venir
    if (occ) {
      statut = 'occupe';
      if (finOcc && !(suivant && suivant.debut <= ajouterJours(finOcc, 1))) { statut = 'se_libere'; date = finOcc; }
    } else if (suivant) { statut = 'arrive'; date = suivant.debut; }
    const etage = espaces.get(b.parent)?.nom || '';
    return {
      uuid: b.uuid, space: b.space, nom: b.nom, etage, surface: b.surface || 0, postes: b.postes || 0, prix_grille: prixGrille,
      statut, date,
      client: occ?.client || (statut === 'arrive' ? suivant.client : ''),
      loyer: part(occ), lot: occ && occ.bureaux.length > 1 ? occ.nom : null,
      fin: finOcc, prochain: suivant ? { client: suivant.client, debut: suivant.debut, loyer: part(suivant) } : null,
    };
  });

  // ------------------------------------------------------------------ synthèse par bâtiment
  const batiments = BATIMENTS.map((B) => {
    const U = unites.filter((u) => u.space === B.space);
    const occupes = U.filter((u) => u.statut === 'occupe' || u.statut === 'se_libere');
    const libres = U.filter((u) => u.statut === 'libre' || u.statut === 'arrive');
    const A = abos.filter((a) => a.space === B.space);
    const loyers = Object.fromEntries(CATEGORIES.map(([k]) => [k, 0]));
    const entrees = Object.fromEntries(CATEGORIES.map(([k]) => [k, 0]));
    const departs = Object.fromEntries(CATEGORIES.map(([k]) => [k, 0]));
    for (const a of A) {
      if (actifLe(a, aujourdhui)) loyers[a.cat] += loyer(a);
      if (a.debut && a.debut.slice(0, 7) === mois) entrees[a.cat] += loyer(a);
      const f = finEffective(a);
      if (f && f.slice(0, 7) === mois) departs[a.cat] += loyer(a);
    }
    const somme = (l, k) => arrondi(l.reduce((s, u) => s + (Number(u[k]) || 0), 0));
    const grilleOccupes = somme(occupes.filter((u) => u.prix_grille != null && u.loyer != null), 'prix_grille');
    const loyersOccupes = somme(occupes.filter((u) => u.prix_grille != null && u.loyer != null), 'loyer');
    return {
      ...B,
      bureaux: U.length, occupes: occupes.length, libres: libres.length,
      surface: somme(U, 'surface'), surface_occupee: somme(occupes, 'surface'),
      postes: somme(U, 'postes'), postes_occupes: somme(occupes, 'postes'),
      stock_vide: somme(libres, 'prix_grille'), potentiel: somme(U, 'prix_grille'),
      remise_bureaux: arrondi(loyersOccupes - grilleOccupes), grille_bureaux_occupes: grilleOccupes,
      loyers: Object.fromEntries(Object.entries(loyers).map(([k, v]) => [k, arrondi(v)])),
      entrees: Object.fromEntries(Object.entries(entrees).map(([k, v]) => [k, arrondi(v)])),
      departs: Object.fromEntries(Object.entries(departs).map(([k, v]) => [k, arrondi(v)])),
      sans_prix: U.filter((u) => u.prix_grille == null).length,
    };
  });
  const total = { code: 'Total', nom: 'Les 4 bâtiments' };
  for (const k of ['bureaux', 'occupes', 'libres', 'surface', 'surface_occupee', 'postes', 'postes_occupes', 'stock_vide', 'potentiel', 'remise_bureaux', 'grille_bureaux_occupes', 'sans_prix']) {
    total[k] = arrondi(batiments.reduce((s, b) => s + b[k], 0));
  }
  for (const g of ['loyers', 'entrees', 'departs']) {
    total[g] = Object.fromEntries(CATEGORIES.map(([k]) => [k, arrondi(batiments.reduce((s, b) => s + b[g][k], 0))]));
  }

  return {
    regle: REGLE_OCC, aujourdhui, mois, horizon,
    batiments, total, unites,
    clients: calculerClients(abos, D.clients || [], espaces, aujourdhui),
    a_venir: {
      departs: unites.filter((u) => u.statut === 'se_libere' && u.date <= horizon).sort((a, b) => a.date.localeCompare(b.date)),
      arrivees: unites.filter((u) => u.prochain && u.prochain.debut <= horizon)
        .map((u) => ({ ...u, date: u.prochain?.debut || u.date, client: u.prochain?.client || u.client, loyer: u.prochain?.loyer ?? u.loyer }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
    non_rattaches: abos.filter((a) => actifLe(a, aujourdhui) && a.type === 'plan' && /r[ée]sident|plateau/i.test(a.nom) && !/co-?r[ée]s|casier/i.test(a.nom) && !a.bureaux.length)
      .map((a) => ({ space: a.space, nom: a.nom, client: a.client, loyer: loyer(a) })),
  };
}

// ------------------------------------------------------------------ clients
const codeBatiment = (space) => BATIMENTS.find((b) => b.space === space)?.code || space;

/** Prochaine hausse du prix de base inscrite dans la grille de prix d'Archie (et la dernière déjà appliquée). */
export function hausses(grille, aujourdhui) {
  const g = (grille || []).filter((x) => x && x[0] && x[1] != null).sort((a, b) => a[0].localeCompare(b[0]));
  const passees = g.filter((x) => x[0] <= aujourdhui);
  const actuel = passees.length ? passees[passees.length - 1][1] : g[0]?.[1] ?? null;
  const suivante = g.find((x) => x[0] > aujourdhui && x[1] !== actuel) || null;
  let derniere = null;
  for (let i = 1; i < passees.length; i++) if (passees[i][1] > passees[i - 1][1]) derniere = passees[i][0];
  return {
    prochaine: suivante && actuel ? { date: suivante[0], de: actuel, a: suivante[1], pct: arrondi(100 * (suivante[1] / actuel - 1)) } : null,
    derniere,
  };
}

/**
 * Un client par groupe Archie (même identifiant sur les 4 bâtiments), ou par nom pour les particuliers.
 * Seuls les clients ayant au moins un abonnement en cours ou à venir sont retenus.
 */
function calculerClients(abos, groupes, espaces, aujourdhui) {
  const fiches = new Map(groupes.map((g) => [g.uuid, g]));
  const parClient = new Map();
  for (const a of abos) {
    const cle = a.group_uuid || 'particulier:' + norm(a.client);
    if (!parClient.has(cle)) parClient.set(cle, []);
    parClient.get(cle).push(a);
  }
  const out = [];
  for (const [cle, L] of parClient) {
    const f = fiches.get(cle) || null;
    const actifs = L.filter((a) => actifLe(a, aujourdhui));
    const futurs = L.filter((a) => a.debut && a.debut > aujourdhui);
    if (!actifs.length && !futurs.length) continue;
    const lignes = [...actifs, ...futurs].sort((a, b) => loyer(b) - loyer(a)).map((a) => {
      const h = hausses(a.grille, aujourdhui);
      return {
        nom: a.nom, batiment: codeBatiment(a.space), cat: a.cat, debut: a.debut, fin: finEffective(a), engagement: a.engagement,
        loyer: arrondi(loyer(a)), prix: a.prix, remise: a.remise, fin_remise: a.fin_remise, a_venir: !actifLe(a, aujourdhui),
        bureaux: a.bureaux.map((u) => espaces.get(u)?.nom).filter(Boolean),
        prochaine_hausse: h.prochaine, derniere_hausse: h.derniere,
      };
    });
    const prochaines = lignes.map((l) => l.prochaine_hausse).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
    const fins = actifs.map(finEffective);
    out.push({
      cle, nom: f?.nom || L[0].client || '(sans nom)', particulier: !L[0].group_uuid,
      batiments: [...new Set(L.map((a) => codeBatiment(a.space)))].sort(),
      bureaux: [...new Set(actifs.flatMap((a) => a.bureaux.map((u) => espaces.get(u)?.nom).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })),
      categories: Object.fromEntries(CATEGORIES.map(([k]) => [k, actifs.filter((a) => a.cat === k).length]).filter(([, n]) => n)),
      loyer: arrondi(actifs.reduce((s, a) => s + loyer(a), 0)),
      loyer_a_venir: arrondi(futurs.reduce((s, a) => s + loyer(a), 0)),
      depuis: L.map((a) => a.debut).filter(Boolean).sort()[0] || null,
      fin: fins.length && fins.every(Boolean) ? fins.sort().pop() : null, // fin du dernier contrat, si tous ont une fin
      prochaine_hausse: prochaines[0] || null,
      emails: f?.emails || [], responsable: f?.responsable || '', responsable_email: f?.responsable_email || null,
      siret: f?.siret || null, membres: f?.membres ?? null,
      abonnements: lignes,
    });
  }
  return out.sort((a, b) => b.loyer - a.loyer);
}

// ------------------------------------------------------------------ revalorisation (lecture seule)
export const PREAVIS_JOURS = 70; // une hausse à moins de 70 jours doit être annoncée maintenant (préavis de 2 mois)
export const ajouterMois = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const fin = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, fin)).padStart(2, '0')}`;
};
const ecart = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000);

/**
 * Un contrat par ligne, avec son statut de revalorisation d'après la grille de prix d'Archie :
 *   programmee : une hausse du prix de base est déjà inscrite dans Archie ;
 *   en_retard  : 12 mois passés depuis la dernière hausse (ou le début du contrat), rien de programmé ;
 *   a_prevenir : anniversaire dans moins de 70 jours, rien de programmé ;
 *   a_jour     : prochain anniversaire plus tard ;
 *   se_termine : le contrat finit avant son prochain anniversaire.
 * Les hausses obtenues en réduisant la remise ne figurent pas dans la grille et ne sont donc pas vues.
 */
export const SANS_PREAVIS_JOURS = 30; // contrat sans préavis de revalorisation : à préparer 30 jours avant

/** Nom de société comparable : majuscules, sans ponctuation ni forme juridique. */
export const nomSociete = (s) => String(s ?? '').toUpperCase().replace(/\(.*?\)/g, ' ')
  .replace(/[^A-Z0-9]+/g, ' ').replace(/\b(SAS|SASU|SARL|SA|SCI|SELARL|EURL|LLP|LLC|LTD|LIMITED|INC|GMBH|SPRL|EI|FRANCE)\b/g, ' ').replace(/\s+/g, ' ').trim();
const memeSociete = (a, b) => { const x = nomSociete(a), y = nomSociete(b); return !!x && !!y && (x === y || x.startsWith(y) || y.startsWith(x)); };
const SERVICES = { bureau: 'bureaux', 'co-résident': 'coresidents', 'co-resident': 'coresidents', itinérant: 'itinerants', itinerant: 'itinerants', parking: 'parking', domiciliation: 'domiciliation' };

/** Règle du classeur pour un contrat : même bâtiment et même bureau, sinon même société et même type de service. */
export function regleDe(a, client, regles) {
  const R = (regles || []).filter((r) => r.batiment === a.batiment);
  if (a.bureaux?.length) {
    const L = R.filter((r) => codes(r.bureau).some((c) => a.bureaux.some((b) => norm(b) === c || norm(b).startsWith(c))));
    return L.find((r) => memeSociete(r.societe, client)) || L[0] || null;
  }
  return R.find((r) => memeSociete(r.societe, client) && SERVICES[String(r.service || '').toLowerCase()] === a.cat) || null;
}

/**
 * Statut de revalorisation de chaque contrat, d'après le calendrier des prix d'Archie et les règles du classeur :
 *   programmee   : hausse inscrite dans Archie ;
 *   bloquee      : pas de revalorisation dans le contrat, au plafond, ou « pas avant le … » ;
 *   a_programmer : hausse notifiée au classeur pour une date à venir, absente d'Archie ;
 *   se_termine   : le contrat finit avant son prochain anniversaire ;
 *   en_retard    : 12 mois passés depuis la dernière hausse (Archie ou classeur) ou le début, rien de programmé ;
 *   a_prevenir   : anniversaire proche (70 jours avec préavis de 2 mois, 30 jours sans préavis) ;
 *   a_jour.
 */
export function revalorisations(clients, aujourdhui, regles = []) {
  const rows = [];
  for (const c of clients || []) {
    for (const a of c.abonnements || []) {
      if (a.a_venir || !(a.loyer > 0)) continue;
      const r = regleDe(a, c.nom, regles);
      // dernière hausse : la plus récente entre Archie et le classeur (qui note aussi les hausses par réduction de remise)
      const derniereClasseur = r?.derniere && r.derniere <= aujourdhui ? r.derniere : null;
      const derniere = [a.derniere_hausse, derniereClasseur].filter(Boolean).sort().pop() || null;
      const base = derniere || a.debut;
      let anniv = base ? ajouterMois(base, 12) : null;
      const fenetre = r ? (r.preavis_mois >= 2 ? PREAVIS_JOURS : SANS_PREAVIS_JOURS) : PREAVIS_JOURS;
      const notifiee = r && r.derniere && r.derniere > aujourdhui && /revalo|indexation|notifi/i.test(r.observations || '');
      let statut, retard = null, gain = 0, motif = null;
      const plusTroisPourcent = Math.round(a.loyer * 3) / 100;
      if (a.prochaine_hausse) {
        statut = 'programmee'; anniv = a.prochaine_hausse.date;
        gain = Math.round(a.loyer * a.prochaine_hausse.pct) / 100;
      } else if (r && !r.revalorisable) {
        statut = 'bloquee'; motif = 'Pas de revalorisation dans le contrat';
      } else if (r?.plafond) {
        statut = 'bloquee'; motif = 'Au plafond';
      } else if (r?.pas_avant && r.pas_avant > aujourdhui && ecart(r.pas_avant, aujourdhui) > fenetre) {
        statut = 'bloquee'; motif = `Pas de hausse avant le ${r.pas_avant.slice(8, 10)}/${r.pas_avant.slice(5, 7)}/${r.pas_avant.slice(0, 4)}`; anniv = r.pas_avant;
      } else if (notifiee) {
        statut = 'a_programmer'; anniv = r.derniere; gain = plusTroisPourcent;
        motif = 'Hausse notifiée (classeur) mais pas programmée dans Archie';
      } else if (anniv && a.fin && a.fin < anniv) {
        statut = 'se_termine';
      } else if (anniv && anniv <= aujourdhui) {
        statut = 'en_retard'; retard = ecart(aujourdhui, anniv); gain = plusTroisPourcent;
      } else if (anniv && ecart(anniv, aujourdhui) <= fenetre) {
        statut = 'a_prevenir'; gain = plusTroisPourcent;
      } else statut = 'a_jour';
      rows.push({
        cle: c.cle, client: c.nom, contrat: a.nom, batiment: a.batiment, cat: a.cat, bureaux: a.bureaux,
        loyer: a.loyer, remise: a.remise, fin_remise: a.fin_remise, debut: a.debut, fin: a.fin,
        derniere, derniere_source: derniere && derniere === derniereClasseur && derniere !== a.derniere_hausse ? 'classeur' : derniere ? 'archie' : null,
        prochaine: a.prochaine_hausse, anniversaire: anniv, statut, retard, gain, motif,
        regle: r ? { preavis_mois: r.preavis_mois, observations: r.observations, societe: r.societe, bureau: r.bureau } : null,
      });
    }
  }
  return rows;
}
