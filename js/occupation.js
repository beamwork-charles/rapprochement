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
  // bureaux : espaces « office » d'Archie, hors postes de co-résident (comptés avec les co-résidents)
  const bureaux = D.espaces.filter((e) => e.categorie === 'office' && !e.archive && !/^co-?r[ée]sident/i.test(e.nom));
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
    const z = a.zones.map((u) => espaces.get(u)).filter((e) => e && e.categorie === 'office' && !e.archive);
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
    if (occ) {
      statut = 'occupe';
      if (finOcc && finOcc <= horizon && !(suivant && suivant.debut <= ajouterJours(finOcc, 1))) { statut = 'se_libere'; date = finOcc; }
    } else if (suivant && suivant.debut <= horizon) { statut = 'arrive'; date = suivant.debut; }
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
    aujourdhui, mois, horizon,
    batiments, total, unites,
    a_venir: {
      departs: unites.filter((u) => u.statut === 'se_libere').sort((a, b) => a.date.localeCompare(b.date)),
      arrivees: unites.filter((u) => u.statut === 'arrive' || (u.prochain && u.prochain.debut <= horizon && u.statut !== 'arrive'))
        .map((u) => ({ ...u, date: u.prochain?.debut || u.date, client: u.prochain?.client || u.client, loyer: u.prochain?.loyer ?? u.loyer }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
    non_rattaches: abos.filter((a) => actifLe(a, aujourdhui) && a.type === 'plan' && /r[ée]sident|plateau/i.test(a.nom) && !/co-?r[ée]s|casier/i.test(a.nom) && !a.bureaux.length)
      .map((a) => ({ space: a.space, nom: a.nom, client: a.client, loyer: loyer(a) })),
  };
}
