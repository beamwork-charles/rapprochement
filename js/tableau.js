// Tableau de bord The Bureau (Charles, Oscar) : page séparée de l'outil de pointage, lecture seule pour l'instant.
// Accès : mot de passe partagé (vérifié par la fonction « tableau », qui renvoie un jeton de 30 jours gardé dans ce
// navigateur), ou session d'un compte autorisé de l'outil de pointage (sans mot de passe).
// Toutes les données passent par la fonction « tableau » ; aucune clé ni donnée dans cette page.

import { calculer, BATIMENTS, CATEGORIES, HORIZON_JOURS, REGLE_OCC, revalorisations, ajouterMois, ajouterJours, PREAVIS_JOURS, codes } from './occupation.js?v=20261127-13';

const C = window.CONFIG || {};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (v) => Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const eur0 = (v) => Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' €';
const dfr = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '');
const dcourt = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '');
const quand = (d) => `${d.toLocaleDateString('fr-FR')} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
const jours = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

const CLE_JETON = 'tableau_jeton';
const AUTO_MIN = 10; // minutes entre deux relectures automatiques d'Archie
const ONGLETS = [
  { id: 'revalo', titre: 'Revalorisation 3 %' },
  { id: 'recouvrement', titre: 'Recouvrement' },
  { id: 'occupation', titre: 'Occupation' },
  { id: 'clients', titre: 'Clients' },
  { id: 'plan', titre: 'Plan' },
];

let sb = null, PRENOM = '', ONGLET = 'recouvrement';
let REC = null; // { R, chargement, maj, erreur, erreurMaj, dernierEssai }
let TRI = 'retard', Q = '';
let OCC = null; // { inst: { calcule_le, par, donnees }, chargement, maj, progression, erreur, erreurMaj }
let OCC_BAT = 'tous', OCC_STATUT = 'tous', OCC_Q = '';
let CLI_BAT = 'tous', CLI_TRI = 'loyer', CLI_Q = '';
let RV_STATUT = 'a_traiter', RV_CAT = 'bureaux', RV_BAT = 'tous', RV_Q = '';
let PLANS = null, PLAN_BAT = 'TB1', PLAN_CHOIX = null, PLAN_STATUT = 'tous', PLAN_Q = ''; // plans d'étage, bâtiment affiché, bureau cliqué, filtres
const CLI_OUVERTS = new Set(); // fiches clients dépliées
const OCC_PERIME_H = 12; // l'instantané est recalculé à l'ouverture s'il a plus de 12 heures
const OUVERTS = new Set();

// ---------------------------------------------------------------------------- appels à la fonction « tableau »
async function appel(quoi, extra = {}) {
  const headers = { 'Content-Type': 'application/json', apikey: C.SUPABASE_ANON_KEY };
  const corps = { quoi, ...extra };
  const jeton = localStorage.getItem(CLE_JETON);
  if (jeton && !('mdp' in extra)) corps.jeton = jeton;
  else if (sb && quoi !== 'entrer') {
    const { data } = await sb.auth.getSession();
    if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  const r = await fetch(`${C.SUPABASE_URL}/functions/v1/tableau`, { method: 'POST', headers, body: JSON.stringify(corps) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Erreur ${r.status}`); e.statut = r.status; throw e; }
  return j;
}
/** Session terminée ou tableau fermé : retour à l'écran du mot de passe. */
function sessionPerdue(e) {
  if (e.statut !== 401) return false;
  localStorage.removeItem(CLE_JETON);
  vueEntree(e.message);
  return true;
}

// ---------------------------------------------------------------------------- entrée
function vueEntree(msg) {
  PRENOM = ''; REC = null;
  $('#who').textContent = ''; $('#b-out').hidden = true; $('#nav').innerHTML = '';
  $('#main').innerHTML = `<div class="center"><h2>Tableau de bord</h2><p>Saisissez le mot de passe du tableau de bord.</p>
    <form class="form" id="f-entree" autocomplete="off">
      <label for="prenom">Votre prénom</label>
      <select id="prenom" required><option value="">Choisir…</option><option>Charles</option><option>Oscar</option><option>Patrick</option><option value="*">Autre…</option></select>
      <input id="prenom-autre" placeholder="Prénom" maxlength="30" hidden>
      <label for="mdp">Mot de passe</label>
      <input id="mdp" type="password" autocomplete="current-password" required>
      <button class="btn primary" id="b-entrer">Entrer</button>
      <div class="err" id="err">${esc(msg || '')}</div>
    </form></div>`;
  const dernier = localStorage.getItem('tableau_prenom');
  if (dernier) {
    const s = $('#prenom');
    if ([...s.options].some((o) => o.value === dernier || o.text === dernier)) s.value = dernier;
    else { s.value = '*'; $('#prenom-autre').hidden = false; $('#prenom-autre').value = dernier; }
  }
  $('#prenom').addEventListener('change', (e) => { $('#prenom-autre').hidden = e.target.value !== '*'; });
  $('#f-entree').addEventListener('submit', async (e) => {
    e.preventDefault();
    const choix = $('#prenom').value;
    const prenom = (choix === '*' ? $('#prenom-autre').value : choix).trim();
    if (!prenom) { $('#err').textContent = 'Indiquez votre prénom.'; return; }
    $('#b-entrer').disabled = true; $('#err').textContent = '';
    try {
      localStorage.removeItem(CLE_JETON);
      const r = await appel('entrer', { mdp: $('#mdp').value, prenom });
      localStorage.setItem(CLE_JETON, r.jeton);
      localStorage.setItem('tableau_prenom', prenom);
      entrer(r.prenom);
    } catch (err) {
      $('#b-entrer').disabled = false; $('#err').textContent = err.message;
    }
  });
}
function entrer(prenom) {
  PRENOM = prenom;
  $('#who').textContent = prenom; $('#b-out').hidden = !localStorage.getItem(CLE_JETON);
  rendu();
  demarrerRecouvrement();
  demarrerOccupation();
  chargerRegles();
  chargerPlans();
}

// ---------------------------------------------------------------------------- recouvrement (données de la fonction « suivi »)
async function demarrerRecouvrement() {
  REC = { R: null, chargement: true, maj: false };
  const etat = REC;
  rendu();
  try { etat.R = await appel('recouvrement'); } catch (e) { if (sessionPerdue(e)) return; etat.erreur = e.message; }
  if (REC !== etat) return;
  etat.chargement = false;
  rendu();
  actualiser();
}
async function actualiser() {
  const etat = REC;
  if (!etat || etat.maj) return;
  etat.maj = true; etat.erreurMaj = null; etat.dernierEssai = Date.now();
  rendu();
  try {
    const R = await appel('recouvrement_actualiser');
    if (REC !== etat) return;
    etat.R = R; etat.erreur = null;
  } catch (e) {
    if (sessionPerdue(e)) return;
    etat.erreurMaj = e.message;
  }
  etat.maj = false;
  if (REC === etat) rendu();
}

// ---------------------------------------------------------------------------- rendu
// Mise en page commune : onglets dans l'en-tête, puis pour chaque onglet un titre, l'état de fraîcheur des données,
// au plus quatre chiffres clés, et des listes filtrables (recherche + listes déroulantes).
function nav() {
  const R = REC?.R, T = OCC?.inst?.donnees?.total, K = OCC?.inst?.donnees?.clients, RV = lignesRevalo();
  const nb = {
    revalo: RV ? RV.filter((r) => r.cat === 'bureaux' && A_TRAITER.has(r.statut)).length : null,
    recouvrement: R ? R.clients.length : null,
    occupation: T ? pct(T.surface_occupee, T.surface) : null,
    clients: K ? K.length : null,
    plan: null,
  };
  $('#nav').innerHTML = ONGLETS.map((o) => `<a class="${ONGLET === o.id ? 'on' : ''}" href="#${o.id}">${esc(o.titre)}${nb[o.id] != null && nb[o.id] !== 0
    ? ` <span class="nb ${o.id === 'revalo' || o.id === 'recouvrement' ? 'alerte' : ''}">${esc(nb[o.id])}</span>` : ''}</a>`).join('');
}

/** Titre de l'onglet, phrase de contexte, fraîcheur des données à droite. */
function tete(titre, phrase, fraicheur = '') {
  return `<div class="tete"><div><h1>${esc(titre)}</h1>${phrase ? `<p>${phrase}</p>` : ''}</div><div class="fraicheur">${fraicheur}</div></div>`;
}
/** Fraîcheur : date du dernier calcul, lecture en cours, erreur, bouton « Actualiser ». */
function fraicheur(date, enCours, erreur, id, progression = '') {
  return `${enCours ? `<span class="spin"></span><span>Lecture d'Archie${progression ? ` · <span id="occ-progression">${esc(progression)}</span>` : '…'}</span>`
    : erreur ? `<span class="ko">Archie non relu : ${esc(erreur)}</span>`
      : date ? `<span>Mis à jour le ${esc(quand(new Date(date)))}</span>` : ''}
    <span>·</span><button class="lienbtn" id="${id}" ${enCours ? 'disabled' : ''}>Actualiser</button>`;
}
/** Chiffres clés : [{ l, v, s, c }] (c : classe de la valeur, « neg » ou « pos »). */
function kpis(L) {
  return `<div class="kpis">${L.map((k) => `<div class="kpi"><div class="l">${esc(k.l)}</div><div class="v ${k.c || ''}">${esc(k.v)}</div>${k.s ? `<div class="s">${esc(k.s)}</div>` : ''}</div>`).join('')}</div>`;
}
/** Liste déroulante de filtre, liée à une variable d'état (data-f). */
function choix(f, valeur, options) {
  return `<select class="choix-f ${valeur !== options[0][0] ? 'actif' : ''}" data-f="${f}">${options.map(([k, t]) => `<option value="${esc(k)}" ${k === valeur ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
}
const OPT_BATS = (tous = 'Tous les bâtiments') => [['tous', tous], ...BATIMENTS.map((b) => [b.code, `${b.code} · ${b.nom}`])];
const attente = (t = 'Chargement…') => `<div class="center"><div class="big-spin"></div><p>${esc(t)}</p></div>`;

function rendu() {
  if (!PRENOM) return;
  nav();
  const m = $('#main');
  const defilement = window.scrollY, actif = document.activeElement?.id, curseur = ['q', 'oq', 'cq', 'rq', 'pq'].includes(actif) ? document.activeElement.selectionStart : null;
  const vues = { recouvrement: [vueRecouvrement, lignes, 'q', (v) => (Q = v)], occupation: [vueOccupation, lignesBureaux, 'oq', (v) => (OCC_Q = v)], clients: [vueClients, lignesClients, 'cq', (v) => (CLI_Q = v)], revalo: [vueRevalo, lignesRevaloTable, 'rq', (v) => (RV_Q = v)], plan: [vuePlan, null, 'pq', (v) => { PLAN_Q = v; surlignerPlan(); }] };
  const [vue, remplir, idq, poser] = vues[ONGLET] || vues.recouvrement;
  m.innerHTML = vue();
  const q = $('#' + idq);
  if (q) { q.addEventListener('input', (e) => { poser(e.target.value); remplir?.(); }); if (curseur !== null && actif === idq) { q.focus(); q.setSelectionRange(curseur, curseur); } }
  remplir?.();
  if (ONGLET === 'plan') { surlignerPlan(); afficherChoixPlan(); }
  window.scrollTo(0, defilement);
}

function vueRecouvrement() {
  if (!REC || (REC.chargement && !REC.R)) return attente();
  const R = REC.R;
  let h = tete('Recouvrement', 'Clients au niveau 5 de relance : la liste suivie par Oscar.', fraicheur(R?.calcule_le, REC.maj, REC.erreurMaj, 'b-actualiser'));
  if (REC.erreur && !R) return h + `<div class="empty">Chargement impossible : ${esc(REC.erreur)}</div>`;
  if (!R) return h + `<div class="empty">Lecture d'Archie en cours…</div>`;
  const tous = R.clients;
  h += kpis([
    { l: 'Clients au niveau 5', v: String(tous.length) },
    { l: 'Restant dû', v: eur0(tous.reduce((s, c) => s + c.total, 0)), c: 'neg' },
    { l: 'Factures concernées', v: String(tous.reduce((s, c) => s + c.factures.length, 0)) },
    { l: 'Avoirs disponibles', v: eur0(tous.reduce((s, c) => s + (c.total_avoirs || 0), 0)), s: `${tous.filter((c) => c.avoirs?.length).length} clients` },
  ]);
  h += `<div class="filtres"><input class="search" id="q" placeholder="Client, email, facture…" value="${esc(Q)}">
    ${choix('TRI', TRI, [['retard', 'Trier par retard'], ['montant', 'Trier par montant'], ['relances', 'Trier par relances']])}
    <span class="compte-res" id="rec-compte"></span></div>
    <div class="tablewrap"><table class="rec"><thead><tr><th>Retard</th><th>Client</th><th class="num">Relances</th><th>Contact</th><th class="num">Montant dû</th></tr></thead><tbody id="corps"></tbody></table></div>
    ${!R.actives ? '<p class="note">Relances automatiques pas encore activées : le niveau 5 est estimé d\'après le retard de la facture la plus ancienne de chaque client.</p>' : ''}
    <div style="height:60px"></div>`;
  return h;
}

function lignes() {
  const R = REC?.R; if (!R || !$('#corps')) return;
  const tous = R.clients;
  const q = Q.trim().toLowerCase();
  const L = tous.filter((c) => !q || [c.client, c.manager, c.manager_email, ...(c.contacts || []), ...c.factures.map((f) => f.ref)].join(' ').toLowerCase().includes(q));
  const cle = { retard: (c) => c.retard_max, montant: (c) => c.total, relances: (c) => c.relances.length };
  L.sort((a, b) => cle[TRI](b) - cle[TRI](a) || b.retard_max - a.retard_max);
  $('#rec-compte').textContent = L.length === tous.length ? `${tous.length} clients` : `${L.length} sur ${tous.length}`;
  $('#corps').innerHTML = L.length ? L.map((c) => ligne(c, R)).join('')
    : `<tr><td colspan="5" class="empty">${tous.length ? 'Aucun client ne correspond à la recherche.' : 'Aucun client au niveau 5.'}</td></tr>`;
}

function ligne(c, R) {
  const depuis = c.date_niveau5 ? Math.max(0, jours(R.aujourdhui, c.date_niveau5)) : null;
  const classe = c.retard_max >= 60 ? 'max' : c.retard_max >= 30 ? 'fort' : '';
  const derniere = c.relances.length ? c.relances[c.relances.length - 1] : null;
  const emails = (c.contacts || []).map((e) => [e, '']);
  if (c.manager_email && !(c.contacts || []).includes(c.manager_email)) emails.push([c.manager_email, 'responsable']);
  // avoirs encore disponibles : numéro et date de chacun (montant restant si le client en a plusieurs)
  const avoir = c.avoirs?.length ? `<div class="avoir">Avoir ${eur(c.total_avoirs)}${c.avoirs.map((a) =>
    `<div class="sub">${esc(a.ref || 'sans numéro')}${a.date ? ` du ${dfr(a.date)}` : ''}${c.avoirs.length > 1 ? ` · ${eur(a.reste)}` : ''}</div>`).join('')}</div>` : '';
  const facs = c.factures.map((f) => `<li>${esc(f.ref)} · ${esc(f.site)} · échéance ${dfr(f.echeance)} · ${eur(f.reste)}</li>`).join('');
  return `<tr>
    <td class="c-retard"><span class="retard ${classe}">${c.retard_max} j</span>
      ${depuis !== null ? `<div class="sub" style="margin-top:4px">niv. 5 depuis ${depuis} j</div>` : ''}</td>
    <td class="c-client"><div class="client">${esc(c.client)}${c.particulier ? '<span class="tag">particulier</span>' : ''}</div>
      <details class="mini" data-c="${esc(c.client)}" ${OUVERTS.has(c.client) ? 'open' : ''}><summary>${c.factures.length} facture${c.factures.length > 1 ? 's' : ''} · ${esc((c.sites || []).join(' + '))}</summary><ul>${facs}</ul></details></td>
    <td class="num c-rel"><b>${c.relances.length}</b><div class="sub">${derniere ? `le ${dfr(derniere)}` : 'aucune'}</div></td>
    <td class="contact c-contact">${c.manager ? `<div>${esc(c.manager)}</div>` : ''}
      ${emails.map(([e, role]) => `<div><a href="mailto:${esc(e)}">${esc(e)}</a>${role ? ` <span class="sub">(${role})</span>` : ''}</div>`).join('') || '<span class="sub">aucun email dans Archie</span>'}</td>
    <td class="num c-montant"><div class="montant">${eur(c.total)}</div>${avoir}</td>
  </tr>`;
}

// ---------------------------------------------------------------------------- événements
/** Filtres en liste déroulante : variable d'état modifiée, puis liste rafraîchie (sans redessiner la page). */
const FILTRES = {
  TRI: [(v) => (TRI = v), () => lignes()],
  OCC_BAT: [(v) => (OCC_BAT = v), () => lignesBureaux()], OCC_STATUT: [(v) => (OCC_STATUT = v), () => lignesBureaux()],
  CLI_BAT: [(v) => (CLI_BAT = v), () => lignesClients()], CLI_TRI: [(v) => (CLI_TRI = v), () => lignesClients()],
  RV_STATUT: [(v) => (RV_STATUT = v), () => lignesRevaloTable()], RV_CAT: [(v) => (RV_CAT = v), () => lignesRevaloTable()], RV_BAT: [(v) => (RV_BAT = v), () => lignesRevaloTable()],
  PLAN_STATUT: [(v) => (PLAN_STATUT = v), () => surlignerPlan()],
};
document.addEventListener('change', (e) => {
  const s = e.target.closest('select[data-f]'); if (!s || !FILTRES[s.dataset.f]) return;
  const [poser, rafraichir] = FILTRES[s.dataset.f];
  poser(s.value); s.classList.toggle('actif', s.selectedIndex > 0); rafraichir();
});
document.addEventListener('click', (e) => {
  const t = e.target.closest('#b-actualiser, #b-occ-actualiser, [data-fiche], [data-pbat], [data-pz], #b-fermer-detail');
  if (!t) return;
  if (t.dataset.pbat) { PLAN_BAT = t.dataset.pbat; PLAN_CHOIX = null; rendu(); return; }
  if (t.dataset.pz) { PLAN_CHOIX = PLAN_CHOIX === t.dataset.pz ? null : t.dataset.pz; afficherChoixPlan(); return; }
  if (t.id === 'b-fermer-detail') { PLAN_CHOIX = null; afficherChoixPlan(); return; }
  if (t.dataset.fiche) { const k = t.dataset.fiche; if (CLI_OUVERTS.has(k)) CLI_OUVERTS.delete(k); else CLI_OUVERTS.add(k); lignesClients(); }
  else if (t.id === 'b-actualiser') actualiser();
  else if (t.id === 'b-occ-actualiser') actualiserOccupation();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && PLAN_CHOIX) { PLAN_CHOIX = null; afficherChoixPlan(); } });
document.addEventListener('toggle', (e) => {
  const c = e.target?.dataset?.c; if (c) { if (e.target.open) OUVERTS.add(c); else OUVERTS.delete(c); }
}, true);
window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (ONGLETS.some((o) => o.id === h)) { ONGLET = h; window.scrollTo(0, 0); rendu(); }
});
$('#b-out').addEventListener('click', async () => {
  try { await appel('sortir'); } catch { /* jeton déjà invalide */ }
  localStorage.removeItem(CLE_JETON);
  vueEntree();
});
const perimees = () => Date.now() - (REC?.dernierEssai || 0) >= AUTO_MIN * 60000 - 5000;
setInterval(() => { if (document.visibilityState === 'visible' && REC && !REC.chargement && !REC.maj && perimees()) actualiser(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && REC && !REC.chargement && !REC.maj && perimees()) actualiser(); });

(async function init() {
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY) { $('#main').innerHTML = '<div class="center"><h2>Configuration en attente</h2></div>'; return; }
  const h = location.hash.slice(1);
  if (ONGLETS.some((o) => o.id === h)) ONGLET = h;
  // session éventuelle de l'outil de pointage (même site) : un compte autorisé entre sans mot de passe
  if (window.supabase) sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: false } });
  try {
    const r = await appel('moi');
    entrer(r.prenom);
  } catch (e) {
    localStorage.removeItem(CLE_JETON);
    vueEntree(e.statut === 401 ? '' : e.message);
  }
})();

// ---------------------------------------------------------------------------- occupation
// (déclarations de fonctions : disponibles dès le chargement du module)
function pct(a, b) { return b > 0 ? Math.round((100 * a) / b) + ' %' : '—'; }
function m2(v) { return Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' m²'; }
const STATUTS = { libre: 'Libre', arrive: 'Signé', occupe: 'Occupé', se_libere: 'Sur le départ' }; // libellés du classeur
const codeBat = (space) => BATIMENTS.find((b) => b.space === space)?.code || '';
const aujourdhuiParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());

async function demarrerOccupation() {
  OCC = { inst: null, chargement: true, maj: false };
  const etat = OCC;
  try { etat.inst = await appel('occupation'); } catch (e) { if (sessionPerdue(e)) return; etat.erreur = e.message; }
  if (OCC !== etat) return;
  etat.chargement = false;
  // recalcul si l'instantané est ancien, s'il date d'avant l'onglet Clients ou d'une règle de statuts antérieure
  if (!etat.erreur && (!etat.inst?.donnees?.clients || etat.inst.donnees.regle !== REGLE_OCC || Date.now() - Date.parse(etat.inst.calcule_le) > OCC_PERIME_H * 3600000)) actualiserOccupation();
  else rendu();
}

/** Relit Archie (bureaux, forfaits, abonnements des 4 bâtiments, par lots), recalcule et enregistre l'instantané. */
async function actualiserOccupation() {
  const etat = OCC;
  if (!etat || etat.maj) return;
  etat.maj = true; etat.erreurMaj = null;
  const D = { espaces: [], forfaits: [], abonnements: [], clients: [], factures: [] };
  let appels = 0;
  const maj = () => {
    etat.progression = `${appels} lecture${appels > 1 ? 's' : ''} · ${D.abonnements.length} abonnements${D.factures.length ? ` · ${D.factures.length} lignes de factures` : ''}`;
    const e = $('#occ-progression'); if (e) e.textContent = etat.progression;
  };
  rendu();
  try {
    await Promise.all(BATIMENTS.map(async (B, i) => {
      // les fiches clients d'Archie sont communes aux 4 bâtiments : lues une seule fois
      // factures des 14 derniers mois : datent la dernière hausse réellement facturée (remise comprise)
      for (const lot of i === 0 ? ['espaces', 'forfaits', 'abonnements', 'clients', 'factures'] : ['espaces', 'forfaits', 'abonnements', 'factures']) {
        let curseur = null;
        do {
          const r = await appel('occupation_lot', { space: B.space, lot, curseur });
          D[lot].push(...r.items); curseur = r.curseur; appels++; maj();
        } while (curseur);
      }
    }));
    const donnees = calculer(D, aujourdhuiParis());
    await appel('occupation_enregistrer', { donnees });
    if (OCC !== etat) return;
    etat.inst = { calcule_le: new Date().toISOString(), par: PRENOM, donnees };
  } catch (e) {
    if (sessionPerdue(e)) return;
    etat.erreurMaj = e.message;
  }
  etat.maj = false;
  if (OCC === etat) rendu();
}

function vueOccupation() {
  if (!OCC || (OCC.chargement && !OCC.inst)) return attente();
  const I = OCC.inst, R = I?.donnees;
  let h = tete('Occupation', 'Bureaux des quatre bâtiments, d\'après les contrats Archie.', fraicheur(I?.calcule_le, OCC.maj, OCC.erreurMaj, 'b-occ-actualiser', OCC.progression));
  if (OCC.erreur && !R) return h + `<div class="empty">Chargement impossible : ${esc(OCC.erreur)}</div>`;
  if (!R) return h + `<div class="empty">Lecture d'Archie en cours (environ 20 secondes)…</div>`;
  const T = R.total;
  const loyersTotal = (x) => CATEGORIES.reduce((s, [k]) => s + (x.loyers[k] || 0), 0);
  const L = [...R.batiments, T];
  h += kpis([
    { l: 'Surface occupée', v: pct(T.surface_occupee, T.surface), s: `${m2(T.surface_occupee)} sur ${m2(T.surface)}` },
    { l: 'Bureaux libres', v: `${T.libres}`, s: `sur ${T.bureaux} bureaux` },
    { l: 'Loyers HT du mois', v: eur0(loyersTotal(T)), s: 'tous abonnements' },
    { l: 'Libres au prix catalogue', v: eur0(T.stock_vide), s: 'par mois' },
  ]);

  h += `<div class="section"><h2>Par bâtiment</h2><div class="tablewrap"><table class="synth"><thead><tr><th>Bâtiment</th><th class="num">Occupation</th><th class="num">Bureaux occupés</th><th class="num">Postes occupés</th><th class="num">Loyers HT du mois</th><th class="num">Libres au catalogue</th><th class="num">Écart au catalogue</th></tr></thead><tbody>${L.map((b) => `<tr class="${b.code === 'Total' ? 'total' : ''}">
      <td><b>${esc(b.code)}</b> <span class="sub">${esc(b.nom)}</span></td>
      <td class="num">${pct(b.surface_occupee, b.surface)} <span class="sub">${m2(b.surface)}</span></td>
      <td class="num">${b.occupes} / ${b.bureaux}</td>
      <td class="num">${b.postes_occupes} / ${b.postes}</td>
      <td class="num">${eur0(loyersTotal(b))}</td>
      <td class="num">${eur0(b.stock_vide)}</td>
      <td class="num">${b.grille_bureaux_occupes ? (b.remise_bureaux > 0 ? '+' : '') + pct(b.remise_bureaux, b.grille_bureaux_occupes) : '—'}</td></tr>`).join('')}</tbody></table></div></div>`;

  // mouvements à venir : départs et arrivées dans une seule liste chronologique
  const mvts = [...R.a_venir.departs.map((u) => ({ ...u, sens: 'depart' })), ...R.a_venir.arrivees.map((u) => ({ ...u, sens: u.statut !== 'arrive' && u.prochain?.client === u.client ? 'renouvellement' : 'arrivee' }))].sort((a, b) => a.date.localeCompare(b.date));
  const SENS = { depart: ['se_libere', 'Départ'], arrivee: ['arrive', 'Arrivée'], renouvellement: ['occupe', 'Renouvellement'] };
  h += `<div class="section"><h2>Mouvements dans les ${HORIZON_JOURS} jours <span class="sub">${['depart', 'arrivee', 'renouvellement'].map((k) => { const n = mvts.filter((m) => m.sens === k).length; return n ? `${n} ${SENS[k][1].toLowerCase()}${n > 1 ? 's' : ''}` : ''; }).filter(Boolean).join(' · ')}</span></h2>
    ${mvts.length ? `<div class="tablewrap"><table class="synth"><tbody>${mvts.map((u) => `<tr><td>${dfr(u.date)}</td>
      <td><span class="statut ${SENS[u.sens][0]}">${SENS[u.sens][1]}</span></td>
      <td><b>${esc(u.nom)}</b> <span class="sub">${esc(codeBat(u.space))}</span></td><td>${esc(u.client)}</td>
      <td class="num">${u.loyer != null ? eur0(u.loyer) : '–'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">Aucun mouvement prévu.</p>'}</div>`;

  h += `<div class="section"><h2>Bureaux</h2><div class="filtres">
    <input class="search" id="oq" placeholder="Bureau, client…" value="${esc(OCC_Q)}">
    ${choix('OCC_BAT', OCC_BAT, OPT_BATS())}
    ${choix('OCC_STATUT', OCC_STATUT, [['tous', 'Tous les statuts'], ['libre', 'Libres'], ['se_libere', 'Sur le départ'], ['arrive', 'Signés'], ['occupe', 'Occupés']])}
    <span class="compte-res" id="occ-compte"></span></div>
    <div class="tablewrap"><table><thead><tr><th>Bureau</th><th>Étage</th><th class="num">Surface</th><th class="num">Postes</th><th>Statut</th><th>Client</th><th class="num">Loyer HT</th><th class="num">Catalogue</th></tr></thead><tbody id="obureaux"></tbody></table></div></div>`;

  const ligneMois = (titre, cle, classe) => `<tr><td>${titre}</td>${L.map((b) => { const v = CATEGORIES.reduce((s, [k]) => s + b[cle][k], 0); return `<td class="num ${classe}">${v ? eur0(v) : '–'}</td>`; }).join('')}</tr>`;
  h += `<details class="pli"><summary>Loyers du mois par catégorie <span class="sub">bureaux, co-résidents, parking…</span></summary><div class="tablewrap"><table class="synth"><thead><tr><th></th>${L.map((b) => `<th class="num">${esc(b.code)}</th>`).join('')}</tr></thead><tbody>
    ${CATEGORIES.map(([k, t]) => `<tr><td>${esc(t)}</td>${L.map((b) => `<td class="num">${b.loyers[k] ? eur0(b.loyers[k]) : '–'}</td>`).join('')}</tr>`).join('')}
    <tr class="total"><td>Total</td>${L.map((b) => `<td class="num">${eur0(loyersTotal(b))}</td>`).join('')}</tr>
    ${ligneMois('Entrées du mois', 'entrees', 'pos')}${ligneMois('Départs du mois', 'departs', 'neg')}
    </tbody></table></div></details>`;
  if (R.non_rattaches?.length) {
    h += `<p class="alerte-l">Abonnements de bureau sans bureau reconnu dans Archie (non comptés) : ${R.non_rattaches.map((a) => `${esc(a.client)} (${esc(a.nom)})`).join(' · ')}</p>`;
  }
  return h + '<div style="height:60px"></div>';
}

function lignesBureaux() {
  const R = OCC?.inst?.donnees; if (!R || !$('#obureaux')) return;
  const q = OCC_Q.trim().toLowerCase();
  const L = R.unites.filter((u) => (OCC_BAT === 'tous' || codeBat(u.space) === OCC_BAT) && (OCC_STATUT === 'tous' || u.statut === OCC_STATUT)
    && (!q || [u.nom, u.client, u.etage].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => codeBat(a.space).localeCompare(codeBat(b.space)) || a.nom.localeCompare(b.nom, 'fr', { numeric: true }));
  $('#occ-compte').textContent = L.length === R.unites.length ? `${L.length} bureaux` : `${L.length} sur ${R.unites.length}`;
  $('#obureaux').innerHTML = L.length ? L.map((u) => `<tr>
      <td><b>${esc(u.nom)}</b> <span class="sub">${esc(codeBat(u.space))}</span></td>
      <td>${esc(u.etage)}</td><td class="num">${u.surface ? m2(u.surface) : '–'}</td><td class="num">${u.postes || '–'}</td>
      <td><span class="statut ${u.statut}">${STATUTS[u.statut]}${u.date ? ` · ${dfr(u.date)}` : ''}</span></td>
      <td>${esc(u.client)}${u.lot ? `<div class="sub">${esc(u.lot)}</div>` : ''}${u.statut !== 'arrive' && u.prochain ? `<div class="sub">puis ${esc(u.prochain.client)} le ${dfr(u.prochain.debut)}</div>` : ''}</td>
      <td class="num">${u.loyer != null ? eur(u.loyer) : '–'}</td><td class="num faible">${u.prix_grille != null ? eur0(u.prix_grille) : '–'}</td></tr>`).join('')
    : '<tr><td colspan="8" class="empty">Aucun bureau ne correspond.</td></tr>';
}

// ---------------------------------------------------------------------------- clients
const CAT_COURT = { bureaux: 'bureau', coresidents: 'co-résident', itinerants: 'itinérant', parking: 'parking', domiciliation: 'domiciliation', autres: 'autre' };
const normNom = (s) => String(s ?? '').toUpperCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/[^A-Z0-9]+/g, ' ').trim();

/** Impayés au niveau 5 (onglet Recouvrement), par nom de client. */
function impayes() {
  const m = new Map();
  for (const c of REC?.R?.clients || []) m.set(normNom(c.client), c);
  return m;
}

function vueClients() {
  if (!OCC || (OCC.chargement && !OCC.inst)) return attente();
  const I = OCC.inst, K = I?.donnees?.clients;
  let h = tete('Clients', 'Contrats en cours ou à venir, regroupés par client. Cliquez un nom pour voir ses contrats et contacts.', fraicheur(I?.calcule_le, OCC.maj, OCC.erreurMaj, 'b-occ-actualiser', OCC.progression));
  if (!K) return h + `<div class="empty">Lecture d'Archie en cours (environ 20 secondes)…</div>`;
  const imp = impayes();
  h += kpis([
    { l: 'Clients', v: String(K.length), s: 'contrat en cours ou à venir' },
    { l: 'Loyers HT du mois', v: eur0(K.reduce((s, c) => s + c.loyer, 0)) },
    { l: 'Hausses programmées', v: String(K.filter((c) => c.prochaine_hausse).length), s: 'dans Archie' },
    { l: 'Au niveau 5 de relance', v: REC?.R ? String(K.filter((c) => imp.has(normNom(c.nom))).length) : '…', c: 'neg' },
  ]);
  h += `<div class="filtres"><input class="search" id="cq" placeholder="Client, bureau, email…" value="${esc(CLI_Q)}">
    ${choix('CLI_BAT', CLI_BAT, OPT_BATS())}
    ${choix('CLI_TRI', CLI_TRI, [['loyer', 'Trier par loyer'], ['nom', 'Trier par nom'], ['depuis', 'Trier par ancienneté'], ['hausse', 'Trier par prochaine hausse']])}
    <span class="compte-res" id="cli-compte"></span></div>
    <div class="tablewrap"><table><thead><tr><th>Client</th><th>Bâtiments</th><th>Bureaux et services</th><th class="num">Loyer HT / mois</th><th>Client depuis</th><th>Prochaine hausse</th><th class="num">Impayé niv. 5</th></tr></thead><tbody id="cclients"></tbody></table></div>
    <div style="height:60px"></div>`;
  return h;
}

function lignesClients() {
  const K = OCC?.inst?.donnees?.clients; if (!K || !$('#cclients')) return;
  const imp = impayes();
  const q = CLI_Q.trim().toLowerCase();
  const tri = {
    loyer: (a, b) => b.loyer - a.loyer,
    nom: (a, b) => a.nom.localeCompare(b.nom, 'fr'),
    depuis: (a, b) => (a.depuis || '9999').localeCompare(b.depuis || '9999'),
    hausse: (a, b) => (a.prochaine_hausse?.date || '9999').localeCompare(b.prochaine_hausse?.date || '9999') || b.loyer - a.loyer,
  }[CLI_TRI];
  const L = K.filter((c) => (CLI_BAT === 'tous' || c.batiments.includes(CLI_BAT))
    && (!q || [c.nom, c.responsable, ...c.emails, ...c.bureaux, ...c.abonnements.map((a) => a.nom)].join(' ').toLowerCase().includes(q))).sort(tri);
  $('#cli-compte').textContent = L.length === K.length ? `${K.length} clients` : `${L.length} sur ${K.length}`;
  $('#cclients').innerHTML = L.length ? L.map((c) => ligneClient(c, imp.get(normNom(c.nom)))).join('')
    : '<tr><td colspan="7" class="empty">Aucun client ne correspond.</td></tr>';
}

function ligneClient(c, impaye) {
  const services = Object.entries(c.categories).filter(([k]) => k !== 'bureaux').map(([k, n]) => `${n} ${CAT_COURT[k]}${n > 1 ? 's' : ''}`);
  const h = c.prochaine_hausse;
  const contrats = c.abonnements.map((a) => `<tr${a.a_venir ? ' class="a-venir"' : ''}>
      <td>${esc(a.nom)}${a.a_venir ? ' <span class="tag">à venir</span>' : ''}</td><td>${esc(a.batiment)}</td>
      <td>${a.debut ? dfr(a.debut) : '–'} → ${a.fin ? dfr(a.fin) : 'sans fin'}</td>
      <td class="num">${eur(a.loyer)}${a.remise ? `<div class="sub">remise ${a.remise} %${a.fin_remise ? ` jusqu'au ${dfr(a.fin_remise)}` : ''}</div>` : ''}</td>
      <td>${a.prochaine_hausse ? `${dfr(a.prochaine_hausse.date)} · ${a.prochaine_hausse.pct > 0 ? '+' : ''}${a.prochaine_hausse.pct} %` : '<span class="sub">aucune programmée</span>'}${a.derniere_hausse ? `<div class="sub">dernière le ${dfr(a.derniere_hausse)}</div>` : ''}</td></tr>`).join('');
  const contacts = [
    c.responsable ? `<div>Responsable : ${esc(c.responsable)}${c.responsable_email ? ` · <a href="mailto:${esc(c.responsable_email)}">${esc(c.responsable_email)}</a>` : ''}</div>` : '',
    c.emails.length ? `<div>Facturation : ${c.emails.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join(', ')}</div>` : '<div class="sub">Aucun email de facturation dans Archie</div>',
    c.siret ? `<div class="sub">SIRET ${esc(c.siret)}</div>` : '',
  ].join('');
  const ouvert = CLI_OUVERTS.has(c.cle);
  const fiche = ouvert ? `<tr class="fiche-ligne"><td colspan="7"><div class="fiche">${contacts}
        <table class="synth contrats"><thead><tr><th>Contrat</th><th>Bât.</th><th>Période</th><th class="num">Loyer HT</th><th>Hausse</th></tr></thead><tbody>${contrats}</tbody></table></div></td></tr>` : '';
  return `<tr class="${ouvert ? 'ouvert' : ''}">
    <td><button class="lien" data-fiche="${esc(c.cle)}"><span class="chev">${ouvert ? '▾' : '▸'}</span>${esc(c.nom)}</button>${c.particulier ? '<span class="tag">particulier</span>' : ''}</td>
    <td>${esc(c.batiments.join(' + '))}</td>
    <td>${c.bureaux.length ? esc(c.bureaux.join(', ')) : ''}${services.length ? `<div class="sub">${esc(services.join(' · '))}</div>` : ''}</td>
    <td class="num"><b>${eur(c.loyer)}</b>${c.loyer_a_venir ? `<div class="sub">+ ${eur0(c.loyer_a_venir)} à venir</div>` : ''}</td>
    <td>${c.depuis ? dfr(c.depuis) : '–'}${c.fin ? `<div class="sub">fin ${dfr(c.fin)}</div>` : ''}</td>
    <td>${h ? `${dfr(h.date)} <span class="sub">${h.pct > 0 ? '+' : ''}${h.pct} %</span>` : '<span class="faible">–</span>'}</td>
    <td class="num">${impaye ? `<span class="neg"><b>${eur0(impaye.total)}</b></span><div class="sub">${impaye.retard_max} j de retard</div>` : '<span class="faible">–</span>'}</td>
  </tr>${fiche}`;
}

// ---------------------------------------------------------------------------- revalorisation (lecture seule)
const RV_STATUTS = {
  en_retard: 'En retard', a_programmer: 'À programmer', a_prevenir: 'À prévenir', programmee: 'Programmée', a_jour: 'À jour',
  bloquee: 'Bloquée', se_termine: 'Se termine avant',
};
const A_TRAITER = new Set(['en_retard', 'a_programmer', 'a_prevenir']);
let REGLES = null; // règles du classeur (fonction « tableau », quoi: 'regles')
async function chargerRegles() {
  try { REGLES = (await appel('regles')).regles || []; RV_CACHE = { inst: null, rows: null }; rendu(); }
  catch (e) { if (!sessionPerdue(e)) REGLES = []; }
}
const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
let RV_CACHE = { inst: null, rows: null };
/** Contrats et statuts de revalorisation, recalculés seulement quand l'instantané change. */
function lignesRevalo() {
  const I = OCC?.inst;
  if (!I?.donnees?.clients) return null;
  if (RV_CACHE.inst !== I) RV_CACHE = { inst: I, rows: revalorisations(I.donnees.clients, aujourdhuiParis(), REGLES || []) };
  return RV_CACHE.rows;
}

function vueRevalo() {
  if (!OCC || (OCC.chargement && !OCC.inst)) return attente();
  const I = OCC.inst, RV = lignesRevalo();
  let h = tete('Revalorisation 3 %', 'Hausse de 3 % à chaque anniversaire du contrat (date d\'entrée en vigueur). Lecture seule pour l\'instant.', fraicheur(I?.calcule_le, OCC.maj, OCC.erreurMaj, 'b-occ-actualiser', OCC.progression));
  if (!RV) return h + `<div class="empty">Lecture d'Archie en cours (environ 20 secondes)…</div>`;
  const bureaux = RV.filter((r) => r.cat === 'bureaux');
  const n = (s, l = bureaux) => l.filter((r) => r.statut === s);
  const somme = (l) => l.reduce((s, r) => s + r.gain, 0);
  h += kpis([
    { l: 'Bureaux en retard', v: String(n('en_retard').length), s: `+${eur0(somme(n('en_retard')))} / mois à +3 %`, c: n('en_retard').length ? 'neg' : '' },
    { l: 'À programmer ou prévenir', v: String(n('a_programmer').length + n('a_prevenir').length), s: 'bureaux' },
    { l: 'Hausses programmées', v: String(n('programmee').length), s: `+${eur0(somme(n('programmee')))} / mois`, c: 'pos' },
    { l: 'À jour ou bloqués', v: String(n('a_jour').length + n('bloquee').length), s: `${n('bloquee').length} bloqués (contrat, plafond)` },
  ]);

  h += `<div class="filtres"><input class="search" id="rq" placeholder="Client, bureau…" value="${esc(RV_Q)}">
    ${choix('RV_STATUT', RV_STATUT, [['a_traiter', 'À traiter'], ['en_retard', 'En retard'], ['a_programmer', 'À programmer'], ['a_prevenir', 'À prévenir'], ['programmee', 'Programmées'], ['a_jour', 'À jour'], ['bloquee', 'Bloquées'], ['se_termine', 'Se terminent avant'], ['tous', 'Tous les statuts']])}
    ${choix('RV_CAT', RV_CAT, [['bureaux', 'Bureaux'], ['coresidents', 'Co-résidents'], ['itinerants', 'Itinérants'], ['parking', 'Parking'], ['domiciliation', 'Domiciliation'], ['tous', 'Toutes catégories']])}
    ${choix('RV_BAT', RV_BAT, OPT_BATS())}
    <span class="compte-res" id="rv-compte"></span></div>
    <div class="tablewrap"><table><thead><tr><th>Statut</th><th>Client</th><th>Bât.</th><th>Bureau</th><th>Dernière hausse</th><th class="num">Ancien prix HT</th><th>Préavis</th><th>Départ</th><th class="num">Nouveau prix HT</th></tr></thead><tbody id="rcontrats"></tbody></table></div>`;

  // calendrier des 12 prochains mois (tous contrats), replié
  const auj = I.donnees.aujourdhui || aujourdhuiParis();
  const mois = Array.from({ length: 12 }, (_, i) => ajouterMois(auj.slice(0, 7) + '-01', i).slice(0, 7));
  const P = Object.fromEntries(mois.map((m) => [m, RV.filter((r) => r.statut === 'programmee' && r.anniversaire?.slice(0, 7) === m)]));
  const A = Object.fromEntries(mois.map((m) => [m, []]));
  for (const r of RV) if ((r.statut === 'a_prevenir' || r.statut === 'a_jour') && A[r.anniversaire?.slice(0, 7)]) A[r.anniversaire.slice(0, 7)].push(r);
  const libMois = (m) => `${MOIS[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`;
  h += `<details class="pli" style="margin-top:26px"><summary>Calendrier des 12 prochains mois <span class="sub">tous contrats</span></summary><div class="tablewrap"><table class="synth"><thead><tr><th></th>${mois.map((m) => `<th class="num">${libMois(m)}</th>`).join('')}</tr></thead><tbody>
    <tr><td>Hausses programmées</td>${mois.map((m) => `<td class="num">${P[m].length || '–'}</td>`).join('')}</tr>
    <tr><td class="sub">gain mensuel</td>${mois.map((m) => `<td class="num pos">${P[m].length ? '+' + eur0(somme(P[m])) : ''}</td>`).join('')}</tr>
    <tr><td>Anniversaires sans hausse programmée</td>${mois.map((m) => `<td class="num">${A[m].length || '–'}</td>`).join('')}</tr>
    </tbody></table></div></details>`;
  const nRegles = RV.filter((r) => r.regle).length;
  h += `<p class="note">La hausse tombe 12 mois après la dernière revalorisation inscrite dans Archie (calendrier des prix), jamais d'après le classeur ; sans revalorisation, à l'anniversaire du contrat (date de début dans Archie, ou date du classeur pour les contrats saisis au 01/05/2021). « À programmer » : hausses du mois suivant seulement. « À prévenir » : contrats avec préavis dont la date limite pour prévenir le client tombe d'ici la fin du mois suivant. « avenant ? » : la dernière hausse ne tombe pas à l'anniversaire du contrat, à vérifier. Le classeur « Recap +3% Contrats »${REGLES ? ` (${REGLES.length} lignes, rapprochées de ${nRegles} contrats)` : ''} sert seulement pour les préavis, blocages et plafonds.</p><div style="height:60px"></div>`;
  return h;
}

function lignesRevaloTable() {
  const RV = lignesRevalo(); if (!RV || !$('#rcontrats')) return;
  const q = RV_Q.trim().toLowerCase();
  const ordre = { en_retard: 0, a_programmer: 1, a_prevenir: 2, programmee: 3, a_jour: 4, bloquee: 5, se_termine: 6 };
  const L = RV.filter((r) => (RV_STATUT === 'tous' || r.statut === RV_STATUT || (RV_STATUT === 'a_traiter' && A_TRAITER.has(r.statut)))
    && (RV_CAT === 'tous' || r.cat === RV_CAT) && (RV_BAT === 'tous' || r.batiment === RV_BAT)
    && (!q || [r.client, r.contrat, ...(r.bureaux || [])].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => ordre[a.statut] - ordre[b.statut] || (a.anniversaire || '9999').localeCompare(b.anniversaire || '9999'));
  const gain = L.reduce((s, r) => s + r.gain, 0);
  $('#rv-compte').textContent = `${L.length} contrat${L.length > 1 ? 's' : ''}${gain ? ` · +${eur0(gain)} / mois` : ''}`;
  // Tableau volontairement court (demande de Charles) : statut et date de la hausse, client, bâtiment, bureau, dernière hausse, ancien prix,
  // préavis, date de départ, nouveau prix. Le détail (motif d'un blocage, observations du classeur) passe en info-bulle.
  $('#rcontrats').innerHTML = L.length ? L.map((r) => {
    const dateHausse = r.statut === 'programmee' ? r.prochaine?.date : ['en_retard', 'a_programmer', 'a_prevenir', 'a_jour'].includes(r.statut) ? r.anniversaire : null;
    const aCorriger = r.statut === 'programmee' && r.motif;
    const bulle = [r.motif, r.regle?.observations].filter(Boolean).join(' — ');
    const preavis = !r.regle ? '<span class="faible" title="Contrat absent du classeur Recap +3%">–</span>' : r.regle.preavis_mois >= 2 ? `${r.regle.preavis_mois} mois` : '<span class="faible">–</span>';
    const bureau = r.bureaux?.length ? [...r.bureaux].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })).join(', ') : r.contrat;
    return `<tr${bulle ? ` title="${esc(bulle)}"` : ''}>
      <td><span class="statut rv-${r.statut}">${RV_STATUTS[r.statut]}</span>${dateHausse ? `<div style="white-space:nowrap" class="sub${r.statut === 'en_retard' ? ' neg' : ''}">${r.statut === 'en_retard' ? 'depuis le ' : 'au '}${dfr(dateHausse)}</div>` : ''}${aCorriger ? '<div class="sub neg">à corriger dans Archie</div>' : ''}</td>
      <td><b>${esc(r.client)}</b></td>
      <td>${esc(r.batiment)}</td>
      <td>${esc(bureau)}</td>
      <td style="white-space:nowrap">${r.derniere ? dfr(r.derniere) : '<span class="faible" title="Aucune hausse dans le calendrier des prix d’Archie">aucune</span>'}${r.hors_anniversaire ? `<div class="sub neg" title="La dernière hausse ne tombe pas à l'anniversaire du contrat : en général un avenant, à vérifier">avenant ? contrat du ${dfr(r.date_contrat)}</div>` : ''}</td>
      <td class="num">${eur(r.loyer)}</td>
      <td style="white-space:nowrap">${preavis}</td>
      <td style="white-space:nowrap">${r.fin ? dfr(r.fin) : '<span class="faible">–</span>'}</td>
      <td class="num">${r.gain ? `<b>${eur(Math.round((r.loyer + r.gain) * 100) / 100)}</b>` : '<span class="faible">–</span>'}</td></tr>`;
  }).join('') : '<tr><td colspan="9" class="empty">Aucun contrat ne correspond.</td></tr>';
}

// ---------------------------------------------------------------------------- plan
// Plans d'étage tirés des plans d'architecte (PDF) : murs vectoriels et forme réelle de chaque bureau, en points de page
// recadrés (géométrie en base, fonction « tableau »). Chaque bureau prend la couleur de son occupation calculée depuis
// Archie (onglet Occupation), avec la légende du classeur « TB - The Bureau ».
const PLAN_STATUTS = { occupe: 'Occupé', se_libere: 'Sur le départ', arrive: 'Signé', libre: 'Libre', inconnu: 'Non trouvé dans Archie', attente: 'Occupation en cours de chargement' };
const PLAN_COUL = { occupe: ['#EF8080', '#7F1D1D'], se_libere: ['#F8B4A0', '#9A3412'], arrive: ['#C4EDB0', '#166534'], libre: ['#7CCF8E', '#14532D'], inconnu: ['#FFFFFF', '#6B7280'], attente: ['#F3F4F6', '#6B7280'] };
const normCode = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, '');
/** Nombre de bureaux d'une zone du plan, comme la colonne « Nb bureaux » du classeur : 0 pour un poste de co-résident, 2 pour « A404-405 ». */
const nbBureauxZone = (code) => (/^P\d{1,2}$/i.test(normCode(code)) ? 0 : Math.max(1, codes(code).length));

async function chargerPlans() {
  try { PLANS = (await appel('plans')).plans || []; rendu(); } catch (e) { if (!sessionPerdue(e)) PLANS = []; }
}

/** Bureau Archie (onglet Occupation) correspondant à un code du plan ; postes de co-résident « P02 » : abonnement « poste n°02 ». */
function etatZone(code, bat) {
  const D = OCC?.inst?.donnees; if (!D) return null;
  const space = BATIMENTS.find((b) => b.code === bat)?.space;
  const n = normCode(code);
  const U = D.unites.filter((u) => u.space === space);
  let u = U.find((x) => normCode(x.nom) === n);
  if (!u) { const cs = codes(code); if (cs.length) u = U.find((x) => codes(x.nom).some((c) => cs.includes(c))) || U.find((x) => cs.some((c) => normCode(x.nom).startsWith(c))); }
  if (u) return { statut: u.statut, client: u.client, loyer: u.loyer, fin: u.fin, date: u.date, surface: u.surface, postes: u.postes, nom: u.nom, prochain: u.prochain };
  const p = n.match(/^P(\d{1,2})$/);
  if (p) {
    const num = Number(p[1]);
    const nom = `Co-résident poste ${num}`;
    const L = [];
    for (const c of D.clients || []) for (const a of c.abonnements || []) {
      const m = String(a.nom).match(/poste\s*n[°o]?\s*0*(\d+)/i);
      if (a.batiment === bat && a.cat === 'coresidents' && m && Number(m[1]) === num) L.push({ ...a, client: c.nom });
    }
    // même règle que les bureaux : « sur le départ » si une fin est connue sans successeur le lendemain, « signé » si seulement à venir
    const actuel = L.find((a) => !a.a_venir);
    const suivant = L.filter((a) => a.a_venir && a.debut).sort((x, y) => x.debut.localeCompare(y.debut))[0];
    if (actuel) {
      const relaye = actuel.fin && suivant && suivant.debut <= ajouterJours(actuel.fin, 1);
      const part = actuel.fin && !relaye;
      return { statut: part ? 'se_libere' : 'occupe', date: part ? actuel.fin : null, client: actuel.client, loyer: actuel.loyer, fin: actuel.fin, nom,
        prochain: suivant ? { client: suivant.client, debut: suivant.debut } : null };
    }
    if (suivant) return { statut: 'arrive', date: suivant.debut, client: suivant.client, loyer: suivant.loyer, nom };
    return { statut: 'libre', client: '', nom };
  }
  return { statut: 'inconnu', client: '', nom: code };
}

/** Nombre de libres et d'occupés d'un étage (en bureaux, comme le classeur) ; postes de co-résident à part. */
function comptesEtage(e, bat) {
  let occupes = 0, libres = 0;
  for (const z of e.bureaux) {
    const st = etatZone(z.code, bat)?.statut; const nb = nbBureauxZone(z.code);
    if (st === 'occupe' || st === 'se_libere') occupes += nb; else if (st === 'libre' || st === 'arrive') libres += nb;
  }
  for (const code of e.absents || []) {
    const st = etatZone(code, bat)?.statut; const nb = nbBureauxZone(code);
    if (st === 'occupe' || st === 'se_libere') occupes += nb; else if (st === 'libre' || st === 'arrive') libres += nb;
  }
  return { occupes, libres };
}

function vuePlan() {
  if (!PLANS) return attente('Chargement des plans…');
  if (!PLANS.length) return `<div class="empty">Aucun plan enregistré.</div>`;
  const P = PLANS.find((p) => p.batiment === PLAN_BAT) || PLANS[0];
  if (!P.etages?.[0]?.bureaux || P.etages[0].fonds) return `<div class="empty">Plans en cours de mise à jour, rechargez la page dans un instant.</div>`;
  const B = BATIMENTS.find((b) => b.code === P.batiment);
  const occ = OCC?.inst?.donnees;
  let h = tete('Plan', 'Plans des étages d\'après les plans d\'architecte, colorés selon l\'occupation Archie. Cliquez un bureau pour le détail.',
    OCC ? fraicheur(OCC.inst?.calcule_le, OCC.maj, OCC.erreurMaj, 'b-occ-actualiser', OCC.progression) : '');
  const tot = P.etages.reduce((a, e) => { const c = comptesEtage(e, P.batiment); return { o: a.o + c.occupes, l: a.l + c.libres }; }, { o: 0, l: 0 });
  h += `<div class="filtres">
    <span class="segments">${PLANS.map((p) => `<button class="${p.batiment === P.batiment ? 'on' : ''}" data-pbat="${p.batiment}">${p.batiment}</button>`).join('')}</span>
    <input class="search" id="pq" placeholder="Bureau, client…" value="${esc(PLAN_Q)}">
    ${choix('PLAN_STATUT', PLAN_STATUT, [['tous', 'Tous les statuts'], ['libre', 'Libres'], ['se_libere', 'Sur le départ'], ['arrive', 'Signés'], ['occupe', 'Occupés']])}
    <span class="compte-res">${esc(B?.nom || '')}${occ ? ` · ${tot.o} occupés · ${tot.l} libres` : ''}</span></div>
    <div class="legende" style="margin:0 0 14px">${['occupe', 'se_libere', 'arrive', 'libre'].map((s) => `<span><i style="background:${PLAN_COUL[s][0]}"></i>${PLAN_STATUTS[s]}</span>`).join('')}</div>
    <div class="etages">`;
  for (const e of P.etages) {
    const c = comptesEtage(e, P.batiment);
    if (e.sansPlan) { // étage dont le plan d'architecte ne situe pas les bureaux : liste seule
      h += `<div class="etage"><div class="etage-t"><b>${esc(e.titre.charAt(0) + e.titre.slice(1).toLowerCase())}</b><span class="sub">${c.occupes} occupé${c.occupes > 1 ? 's' : ''} · ${c.libres} libre${c.libres > 1 ? 's' : ''}</span></div>
        <div class="sub" style="margin-bottom:8px">Plan d'étage non disponible.</div><div style="display:flex;flex-direction:column;gap:4px">${(e.absents || []).map((code) => { const s = etatZone(code, P.batiment); return `<span class="statut ${s?.statut || ''}">${esc(code)}${s?.client ? ' · ' + esc(s.client) : ''}</span>`; }).join('')}</div></div>`;
      continue;
    }
    const fsz = Math.min(e.l, e.h * 1.5) / 22, trait = e.l / 320;
    const bureaux = e.bureaux.map((z) => {
      const s = etatZone(z.code, P.batiment);
      const st = s?.statut || (occ ? 'inconnu' : 'attente');
      const [fond, encre] = PLAN_COUL[st];
      const cle = `${P.batiment}|${z.code}`;
      const titre = `${z.code} · ${PLAN_STATUTS[st]}${s?.client ? ' · ' + s.client : ''}`;
      const etiquette = String(z.code).replace(/^[A-D](?=\d)/, '');
      const taille = Math.min(fsz, (z.larg || fsz * 4) / Math.max(3, etiquette.length) * 1.6);
      return `<g class="pz${PLAN_CHOIX === cle ? ' choisi' : ''}" data-pz="${esc(cle)}" data-st="${st}" data-q="${esc((z.code + ' ' + (s?.client || '')).toLowerCase())}"><title>${esc(titre)}</title>
        ${z.polys.map((p) => `<path d="M${p.map((q) => `${Number(q[0])} ${Number(q[1])}`).join('L')}Z" fill="${fond}"${st === 'inconnu' ? ' stroke-dasharray="3 2"' : ''}/>`).join('')}
        <text x="${Number(z.lab[0])}" y="${Number(z.lab[1])}" text-anchor="middle" dominant-baseline="central" font-weight="700" fill="${encre}" style="font-size:${taille.toFixed(1)}px">${esc(etiquette)}</text></g>`;
    }).join('');
    // murs dessinés en traits : épaisseur du PDF, mais au moins ~1 px une fois le plan réduit
    const traits = (e.traits || []).map((t) => `<path d="${esc(t.d)}" fill="none" stroke="#3A3F47" stroke-width="${Math.max(Number(t.ep), e.l / 380).toFixed(2)}" stroke-linecap="square"/>`).join('');
    // bureaux de l'étage que le plan ne situe pas : listés sous le dessin avec leur statut
    const absents = (e.absents || []).filter((code) => !/^P\d/.test(code)).map((code) => { const s = etatZone(code, P.batiment); return `<span class="statut ${s?.statut || ''}">${esc(code)}${s?.client ? ' · ' + esc(s.client) : ''}</span>`; });
    const postes = (e.absents || []).filter((code) => /^P\d/.test(code)).sort((x, y) => x.localeCompare(y, 'fr', { numeric: true }));
    const postesOcc = postes.filter((code) => ['occupe', 'se_libere'].includes(etatZone(code, P.batiment)?.statut)).length;
    h += `<div class="etage"><div class="etage-t"><b>${esc(e.titre.charAt(0) + e.titre.slice(1).toLowerCase())}</b><span class="sub">${c.occupes} occupé${c.occupes > 1 ? 's' : ''} · ${c.libres} libre${c.libres > 1 ? 's' : ''}</span></div>
      <svg class="plan" viewBox="0 0 ${Number(e.l)} ${Number(e.h)}" style="--trait:${trait.toFixed(2)}">${e.sol ? `<path class="sol" d="${esc(e.sol)}"/>` : ''}${bureaux}<path class="mur" d="${esc(e.murs)}"/>${traits}</svg>
      ${absents.length ? `<div class="sub" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px 12px">Non situés sur ce plan : ${absents.join('')}</div>` : ''}
      ${postes.length ? `<div class="sub" style="margin-top:6px">Postes co-résidents ${esc(postes[0])}–${esc(postes[postes.length - 1])} : <b>${postesOcc}</b> occupés sur ${postes.length}</div>` : ''}</div>`;
  }
  return h + '</div><div id="plan-detail"></div><div style="height:80px"></div>';
}

/** Estompe les bureaux hors filtre (statut, recherche) sans redessiner les plans. */
function surlignerPlan() {
  const q = PLAN_Q.trim().toLowerCase();
  document.querySelectorAll('svg.plan .pz').forEach((g) => {
    const ok = (PLAN_STATUT === 'tous' || g.dataset.st === PLAN_STATUT) && (!q || g.dataset.q.includes(q));
    g.classList.toggle('estompe', !ok);
  });
}

/** Fiche du bureau cliqué, en carte flottante (sans redessiner le plan). */
function afficherChoixPlan() {
  document.querySelectorAll('svg.plan .pz').forEach((g) => g.classList.toggle('choisi', g.dataset.pz === PLAN_CHOIX));
  const el = $('#plan-detail'); if (!el) return;
  if (!PLAN_CHOIX) { el.innerHTML = ''; return; }
  const [bat, code] = PLAN_CHOIX.split('|');
  const s = etatZone(code, bat) || { statut: 'inconnu' };
  const rv = (lignesRevalo() || []).find((r) => r.batiment === bat && r.client === s.client && (r.bureaux || []).some((b) => normCode(b) === normCode(s.nom)));
  const ligne = (t, v) => (v ? `<dt>${t}</dt><dd>${v}</dd>` : '');
  el.innerHTML = `<div class="detail"><button class="fermer" id="b-fermer-detail" title="Fermer">×</button>
    <h3>${esc(code)} <span class="sub" style="font-weight:400">${esc(bat)}</span></h3>
    <span class="statut ${s.statut}">${esc(PLAN_STATUTS[s.statut] || '')}${s.date ? ' · ' + dfr(s.date) : ''}</span>
    <dl>${ligne('Client', s.client ? esc(s.client) : '')}${ligne('Loyer HT', s.loyer != null ? eur(s.loyer) + ' / mois' : '')}${ligne('Surface', s.surface ? m2(s.surface) : '')}${ligne('Postes', s.postes ? String(s.postes) : '')}
      ${ligne('Fin du contrat', s.fin ? dfr(s.fin) : '')}${ligne('Ensuite', s.prochain ? `${esc(s.prochain.client)} le ${dfr(s.prochain.debut)}` : '')}
      ${ligne('Revalorisation', rv ? `${esc(RV_STATUTS[rv.statut])}${rv.prochaine ? ` · ${dfr(rv.prochaine.date)} +${rv.prochaine.pct} %` : rv.anniversaire ? ` · anniversaire le ${dfr(rv.anniversaire)}` : ''}` : '')}</dl></div>`;
}
