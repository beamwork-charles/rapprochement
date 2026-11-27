// Tableau de bord The Bureau (Charles, Oscar) : page séparée de l'outil de pointage, lecture seule pour l'instant.
// Accès : mot de passe partagé (vérifié par la fonction « tableau », qui renvoie un jeton de 30 jours gardé dans ce
// navigateur), ou session d'un compte autorisé de l'outil de pointage (sans mot de passe).
// Toutes les données passent par la fonction « tableau » ; aucune clé ni donnée dans cette page.

import { calculer, BATIMENTS, CATEGORIES, HORIZON_JOURS, REGLE_OCC, revalorisations, ajouterMois, ajouterJours, PREAVIS_JOURS, codes } from './occupation.js?v=20261127-9';

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
let PLANS = null, PLAN_BAT = 'TB1', PLAN_CHOIX = null; // plans d'étage, bâtiment affiché, bureau cliqué
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
  $('#who').textContent = ''; $('#b-out').hidden = true;
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
function tuiles() {
  const R = REC?.R;
  const T = OCC?.inst?.donnees?.total;
  const enCours = OCC?.chargement || OCC?.maj;
  const K = OCC?.inst?.donnees?.clients;
  const RV = lignesRevalo();
  const compteur = {
    recouvrement: R ? String(R.clients.length) : '…',
    occupation: T ? pct(T.surface_occupee, T.surface) : (enCours ? '…' : ''),
    clients: K ? String(K.length) : (enCours ? '…' : ''),
    revalo: RV ? String(RV.filter((r) => r.cat === 'bureaux' && A_TRAITER.has(r.statut)).length) : (enCours ? '…' : ''),
    plan: PLANS ? String(PLANS.reduce((s, p) => s + p.etages.length, 0)) : '',
  };
  const sous = {
    recouvrement: R ? `clients au niveau 5 · ${eur0(R.clients.reduce((s, c) => s + c.total, 0))}` : 'chargement',
    occupation: T ? `surface occupée · ${T.libres} bureaux libres` : (enCours ? 'chargement' : 'en préparation'),
    clients: K ? `clients en cours · ${eur0(K.reduce((s, c) => s + c.loyer, 0))} / mois` : (enCours ? 'chargement' : 'en préparation'),
    revalo: RV ? `bureaux à traiter · ${RV.filter((r) => r.cat === 'bureaux' && r.statut === 'programmee').length} hausses programmées` : (enCours ? 'chargement' : 'en préparation'),
    plan: PLANS ? `étages dessinés · ${PLANS.length} bâtiments` : 'chargement',
  };
  return `<nav class="tiles">${ONGLETS.map((o) => `<a class="tile ${o.id} ${ONGLET === o.id ? 'on' : ''}" href="#${o.id}">
    <div class="t">${esc(o.titre)}</div><div class="n ${compteur[o.id] ? '' : 'vide'}">${esc(compteur[o.id] || '—')}</div>
    <div class="s">${esc(sous[o.id] || 'en préparation')}</div><div class="bar"></div></a>`).join('')}</nav>`;
}

function rendu() {
  if (!PRENOM) return;
  const m = $('#main');
  const defilement = window.scrollY, recherche = ['q', 'oq', 'cq', 'rq'].includes(document.activeElement?.id) ? document.activeElement.selectionStart : null;
  let h = tuiles();
  if (ONGLET === 'plan') {
    m.innerHTML = h + vuePlan();
    window.scrollTo(0, defilement);
    return;
  }
  if (ONGLET === 'revalo') {
    m.innerHTML = h + vueRevalo();
    const q = $('#rq');
    if (q) { q.addEventListener('input', (e) => { RV_Q = e.target.value; lignesRevaloTable(); }); lignesRevaloTable(); if (recherche !== null) { q.focus(); q.setSelectionRange(recherche, recherche); } }
    window.scrollTo(0, defilement);
    return;
  }
  if (ONGLET === 'clients') {
    m.innerHTML = h + vueClients();
    const q = $('#cq');
    if (q) { q.addEventListener('input', (e) => { CLI_Q = e.target.value; lignesClients(); }); lignesClients(); if (recherche !== null) { q.focus(); q.setSelectionRange(recherche, recherche); } }
    window.scrollTo(0, defilement);
    return;
  }
  if (ONGLET === 'occupation') {
    m.innerHTML = h + vueOccupation();
    const q = $('#oq');
    if (q) { q.addEventListener('input', (e) => { OCC_Q = e.target.value; lignesBureaux(); }); lignesBureaux(); if (recherche !== null) { q.focus(); q.setSelectionRange(recherche, recherche); } }
    window.scrollTo(0, defilement);
    return;
  }
  if (ONGLET !== 'recouvrement') {
    const o = ONGLETS.find((x) => x.id === ONGLET);
    m.innerHTML = h + `<div class="bientot"><h2>${esc(o.titre)}</h2><p>En préparation.</p></div>`;
    return;
  }
  h += vueRecouvrement();
  m.innerHTML = h;
  if ($('#q')) {
    $('#q').addEventListener('input', (e) => { Q = e.target.value; lignes(); });
    lignes();
    if (recherche !== null) { const q = $('#q'); q.focus(); q.setSelectionRange(recherche, recherche); }
  }
  window.scrollTo(0, defilement);
}

function vueRecouvrement() {
  if (!REC || (REC.chargement && !REC.R)) return `<div class="center"><div class="big-spin"></div><p>Chargement…</p></div>`;
  const R = REC.R;
  const etatArchie = REC.maj
    ? `<span class="maj"><span class="spin"></span> Mise à jour depuis Archie…</span>`
    : REC.erreurMaj ? `<span class="maj ko">Archie non relu : ${esc(REC.erreurMaj)}</span>` : '';
  let h = `<div class="etat">${R?.calcule_le ? `<span>Dernière mise à jour : <b>${esc(quand(new Date(R.calcule_le)))}</b></span>` : '<span>Aucune donnée enregistrée</span>'}
    ${etatArchie}<button class="btn sm" id="b-actualiser" ${REC.maj ? 'disabled' : ''}>Actualiser</button>
    <span>· mise à jour automatique toutes les ${AUTO_MIN} minutes</span></div>`;
  if (REC.erreur && !R) return h + `<div class="empty">Chargement impossible : ${esc(REC.erreur)}</div>`;
  if (!R) return h + `<div class="empty">Lecture d'Archie en cours…</div>`;
  if (!R.actives) h += `<div class="info">Les relances automatiques ne sont pas encore activées : le niveau 5 est estimé d'après le retard de la facture la plus ancienne de chaque client.</div>`;
  const tous = R.clients;
  h += `<div class="resume"><div><div class="n">${tous.length}</div><div class="l">clients au niveau 5</div></div>
    <div><div class="n">${eur0(tous.reduce((s, c) => s + c.total, 0))}</div><div class="l">restant dû</div></div>
    <div><div class="n">${tous.reduce((s, c) => s + c.factures.length, 0)}</div><div class="l">factures</div></div></div>
    <div class="outils"><input class="search" id="q" placeholder="Rechercher un client, un email, une facture…" value="${esc(Q)}">
    <span class="tri" id="tri"></span></div>
    <table class="rec"><thead><tr><th>Retard</th><th>Client</th><th class="num">Relances</th><th>Contact</th><th class="num">Montant dû</th></tr></thead><tbody id="corps"></tbody></table><div style="height:60px"></div>`;
  return h;
}

function lignes() {
  const R = REC?.R; if (!R || !$('#corps')) return;
  const tous = R.clients;
  const q = Q.trim().toLowerCase();
  const L = tous.filter((c) => !q || [c.client, c.manager, c.manager_email, ...(c.contacts || []), ...c.factures.map((f) => f.ref)].join(' ').toLowerCase().includes(q));
  const cle = { retard: (c) => c.retard_max, montant: (c) => c.total, relances: (c) => c.relances.length };
  L.sort((a, b) => cle[TRI](b) - cle[TRI](a) || b.retard_max - a.retard_max);
  $('#tri').innerHTML = 'Trier par ' + [['retard', 'retard'], ['montant', 'montant'], ['relances', 'relances']]
    .map(([k, t]) => `<button class="${TRI === k ? 'on' : ''}" data-tri="${k}">${t}</button>`).join('');
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
  const avoir = c.avoirs?.length ? `<div class="avoir">Avoir disponible ${eur(c.total_avoirs)}${c.avoirs.map((a) =>
    `<div class="sub">${esc(a.ref || 'avoir sans numéro')}${a.date ? ` du ${dfr(a.date)}` : ''}${c.avoirs.length > 1 ? ` · ${eur(a.reste)}` : ''}</div>`).join('')}</div>` : '';
  const facs = c.factures.map((f) => `<li>${esc(f.ref)} · ${esc(f.site)} · échéance ${dfr(f.echeance)} · ${eur(f.reste)}</li>`).join('');
  return `<tr>
    <td data-l="Retard" class="c-retard"><span class="compteur ${classe}"><span class="v">${c.retard_max}</span> j</span>
      ${depuis !== null ? `<div class="sub" style="margin-top:4px">niveau 5 depuis ${depuis} j (${dcourt(c.date_niveau5)})</div>` : ''}</td>
    <td data-l="Client" class="c-client"><div class="client">${esc(c.client)}${c.particulier ? '<span class="tag">particulier</span>' : ''}</div>
      <details data-c="${esc(c.client)}" ${OUVERTS.has(c.client) ? 'open' : ''}><summary>${c.factures.length} facture${c.factures.length > 1 ? 's' : ''} · ${esc((c.sites || []).join(' + '))}</summary><ul>${facs}</ul></details></td>
    <td data-l="Relances" class="num relances c-rel"><div class="v">${c.relances.length}</div><div class="sub">${derniere ? `dernière le ${dfr(derniere)}` : 'aucune'}</div></td>
    <td data-l="Contact" class="contact c-contact">${c.manager ? `<div>${esc(c.manager)}</div>` : ''}
      ${emails.map(([e, role]) => `<div><a href="mailto:${esc(e)}">${esc(e)}</a>${role ? ` <span class="sub">(${role})</span>` : ''}</div>`).join('') || '<span class="sub">aucun email dans Archie</span>'}</td>
    <td data-l="Montant dû" class="num c-montant"><div class="montant">${eur(c.total)}</div>${avoir}</td>
  </tr>`;
}

// ---------------------------------------------------------------------------- événements
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-tri], #b-actualiser, #b-occ-actualiser, [data-bat], [data-statut], [data-cbat], [data-ctri], [data-fiche], [data-rstatut], [data-rcat], [data-rbat], [data-pbat], [data-pz]');
  if (!t) return;
  if (t.dataset.pbat) { PLAN_BAT = t.dataset.pbat; PLAN_CHOIX = null; rendu(); return; }
  if (t.dataset.pz) { PLAN_CHOIX = PLAN_CHOIX === t.dataset.pz ? null : t.dataset.pz; afficherChoixPlan(); return; }
  if (t.dataset.rstatut || t.dataset.rcat || t.dataset.rbat) {
    if (t.dataset.rstatut) RV_STATUT = t.dataset.rstatut;
    if (t.dataset.rcat) RV_CAT = t.dataset.rcat;
    if (t.dataset.rbat) RV_BAT = t.dataset.rbat;
    lignesRevaloTable();
  } else if (t.dataset.fiche) { const k = t.dataset.fiche; if (CLI_OUVERTS.has(k)) CLI_OUVERTS.delete(k); else CLI_OUVERTS.add(k); lignesClients(); }
  else if (t.id === 'b-actualiser') actualiser();
  else if (t.id === 'b-occ-actualiser') actualiserOccupation();
  else if (t.dataset.cbat) { CLI_BAT = t.dataset.cbat; lignesClients(); }
  else if (t.dataset.ctri) { CLI_TRI = t.dataset.ctri; lignesClients(); }
  else if (t.dataset.bat) { OCC_BAT = t.dataset.bat; lignesBureaux(); marquerFiltres(); }
  else if (t.dataset.statut) { OCC_STATUT = t.dataset.statut; lignesBureaux(); marquerFiltres(); }
  else { TRI = t.dataset.tri; lignes(); }
});
document.addEventListener('toggle', (e) => {
  const c = e.target?.dataset?.c; if (c) { if (e.target.open) OUVERTS.add(c); else OUVERTS.delete(c); }
  const k = e.target?.dataset?.k; if (k) { if (e.target.open) CLI_OUVERTS.add(k); else CLI_OUVERTS.delete(k); }
}, true);
window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (ONGLETS.some((o) => o.id === h)) { ONGLET = h; rendu(); }
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
  const D = { espaces: [], forfaits: [], abonnements: [], clients: [] };
  let appels = 0;
  const maj = () => {
    etat.progression = `${appels} lecture${appels > 1 ? 's' : ''} · ${D.abonnements.length} abonnements`;
    const e = $('#occ-progression'); if (e) e.textContent = etat.progression;
  };
  rendu();
  try {
    await Promise.all(BATIMENTS.map(async (B, i) => {
      // les fiches clients d'Archie sont communes aux 4 bâtiments : lues une seule fois
      for (const lot of i === 0 ? ['espaces', 'forfaits', 'abonnements', 'clients'] : ['espaces', 'forfaits', 'abonnements']) {
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
  if (!OCC || (OCC.chargement && !OCC.inst)) return `<div class="center"><div class="big-spin"></div><p>Chargement…</p></div>`;
  const I = OCC.inst, R = I?.donnees;
  const etatArchie = OCC.maj
    ? `<span class="maj"><span class="spin"></span> Lecture d'Archie — <span id="occ-progression">${esc(OCC.progression || '')}</span></span>`
    : OCC.erreurMaj ? `<span class="maj ko">Archie non relu : ${esc(OCC.erreurMaj)}</span>` : '';
  let h = `<div class="etat">${I?.calcule_le ? `<span>Calculé le <b>${esc(quand(new Date(I.calcule_le)))}</b>${I.par ? ` par ${esc(I.par)}` : ''}</span>` : '<span>Pas encore calculé</span>'}
    ${etatArchie}<button class="btn sm" id="b-occ-actualiser" ${OCC.maj ? 'disabled' : ''}>Actualiser</button></div>`;
  if (OCC.erreur && !R) return h + `<div class="empty">Chargement impossible : ${esc(OCC.erreur)}</div>`;
  if (!R) return h + `<div class="empty">Lecture d'Archie en cours (environ 20 secondes)…</div>`;
  const T = R.total;
  const loyersTotal = (x) => CATEGORIES.reduce((s, [k]) => s + (x.loyers[k] || 0), 0);
  const L = [...R.batiments, T];
  h += `<div class="resume">
    <div><div class="n">${pct(T.surface_occupee, T.surface)}</div><div class="l">surface occupée · ${m2(T.surface_occupee)} sur ${m2(T.surface)}</div></div>
    <div><div class="n">${T.occupes} / ${T.bureaux}</div><div class="l">bureaux occupés</div></div>
    <div><div class="n">${eur0(loyersTotal(T))}</div><div class="l">loyers HT du mois</div></div>
    <div><div class="n">${eur0(T.stock_vide)}</div><div class="l">bureaux libres au prix catalogue</div></div></div>`;

  h += `<h3 class="titre">Par bâtiment</h3><div class="tablewrap"><table class="synth"><thead><tr><th>Bâtiment</th><th class="num">Bureaux occupés</th><th class="num">Surface occupée</th><th class="num">Postes occupés</th><th class="num">Loyers HT du mois</th><th class="num">Libres au catalogue</th><th class="num">Écart au catalogue</th></tr></thead><tbody>${L.map((b) => `<tr class="${b.code === 'Total' ? 'total' : ''}">
      <td><b>${esc(b.code)}</b> <span class="sub">${esc(b.nom)}</span></td>
      <td class="num">${b.occupes} / ${b.bureaux}</td>
      <td class="num">${pct(b.surface_occupee, b.surface)} <span class="sub">${m2(b.surface_occupee)} / ${m2(b.surface)}</span></td>
      <td class="num">${b.postes_occupes} / ${b.postes}</td>
      <td class="num">${eur0(loyersTotal(b))}</td>
      <td class="num">${eur0(b.stock_vide)}</td>
      <td class="num">${b.grille_bureaux_occupes ? (b.remise_bureaux > 0 ? '+' : '') + pct(b.remise_bureaux, b.grille_bureaux_occupes) : '—'}</td></tr>`).join('')}</tbody></table></div>`;

  const ligneMois = (titre, cle, classe) => `<tr><td>${titre}</td>${L.map((b) => { const v = CATEGORIES.reduce((s, [k]) => s + b[cle][k], 0); return `<td class="num ${classe}">${v ? eur0(v) : '–'}</td>`; }).join('')}</tr>`;
  h += `<h3 class="titre">Loyers HT du mois par catégorie</h3><div class="tablewrap"><table class="synth"><thead><tr><th></th>${L.map((b) => `<th class="num">${esc(b.code)}</th>`).join('')}</tr></thead><tbody>
    ${CATEGORIES.map(([k, t]) => `<tr><td>${esc(t)}</td>${L.map((b) => `<td class="num">${b.loyers[k] ? eur0(b.loyers[k]) : '–'}</td>`).join('')}</tr>`).join('')}
    <tr class="total"><td>Total</td>${L.map((b) => `<td class="num">${eur0(loyersTotal(b))}</td>`).join('')}</tr>
    ${ligneMois('Entrées du mois', 'entrees', 'pos')}${ligneMois('Départs du mois', 'departs', 'neg')}
    </tbody></table></div>`;

  const ligneAVenir = (u) => `<tr><td>${dfr(u.date)}</td><td><b>${esc(u.nom)}</b> <span class="sub">${esc(codeBat(u.space))}</span></td><td>${esc(u.client)}</td><td class="num">${u.loyer != null ? eur0(u.loyer) : '–'}</td></tr>`;
  const bloc = (titre, l, vide) => `<div><h3 class="titre">${titre} <span class="sub">(${l.length})</span></h3>${l.length ? `<table class="synth"><tbody>${l.map(ligneAVenir).join('')}</tbody></table>` : `<div class="sub">${vide}</div>`}</div>`;
  h += `<div class="deux">${bloc(`Départs dans les ${HORIZON_JOURS} jours`, R.a_venir.departs, 'Aucun')}${bloc(`Arrivées dans les ${HORIZON_JOURS} jours`, R.a_venir.arrivees, 'Aucune')}</div>`;

  h += `<h3 class="titre">Bureaux</h3><div class="outils">
    <span class="tri" id="f-bat">${[['tous', 'Tous'], ...BATIMENTS.map((b) => [b.space, b.code])].map(([k, t]) => `<button class="${OCC_BAT === k ? 'on' : ''}" data-bat="${k}">${t}</button>`).join('')}</span>
    <span class="tri" id="f-statut">${[['tous', 'Tous'], ['libre', 'Libres'], ['se_libere', 'Sur le départ'], ['arrive', 'Signés'], ['occupe', 'Occupés']].map(([k, t]) => `<button class="${OCC_STATUT === k ? 'on' : ''}" data-statut="${k}">${t}</button>`).join('')}</span>
    <input class="search" id="oq" placeholder="Rechercher un bureau, un client…" value="${esc(OCC_Q)}"></div>
    <div class="tablewrap"><table class="bureaux"><thead><tr><th>Bureau</th><th>Étage</th><th class="num">Surface</th><th class="num">Postes</th><th>Statut</th><th>Client</th><th class="num">Loyer HT</th><th class="num">Catalogue</th></tr></thead><tbody id="obureaux"></tbody></table></div>`;
  if (R.non_rattaches?.length) {
    h += `<div class="info">Abonnements de bureau sans bureau reconnu dans Archie, non comptés dans l'occupation : ${R.non_rattaches.map((a) => `${esc(a.client)} (${esc(a.nom)})`).join(' · ')}</div>`;
  }
  return h + '<div style="height:60px"></div>';
}

function marquerFiltres() {
  document.querySelectorAll('[data-bat]').forEach((b) => b.classList.toggle('on', b.dataset.bat === OCC_BAT));
  document.querySelectorAll('[data-statut]').forEach((b) => b.classList.toggle('on', b.dataset.statut === OCC_STATUT));
}

function lignesBureaux() {
  const R = OCC?.inst?.donnees; if (!R || !$('#obureaux')) return;
  const q = OCC_Q.trim().toLowerCase();
  const L = R.unites.filter((u) => (OCC_BAT === 'tous' || u.space === OCC_BAT) && (OCC_STATUT === 'tous' || u.statut === OCC_STATUT)
    && (!q || [u.nom, u.client, u.etage].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => codeBat(a.space).localeCompare(codeBat(b.space)) || a.nom.localeCompare(b.nom, 'fr', { numeric: true }));
  $('#obureaux').innerHTML = L.length ? L.map((u) => `<tr>
      <td><b>${esc(u.nom)}</b> <span class="sub">${esc(codeBat(u.space))}</span></td>
      <td>${esc(u.etage)}</td><td class="num">${u.surface ? m2(u.surface) : '–'}</td><td class="num">${u.postes || '–'}</td>
      <td><span class="statut ${u.statut}">${STATUTS[u.statut]}${u.date ? ` ${dfr(u.date)}` : ''}</span></td>
      <td>${esc(u.client)}${u.lot ? `<div class="sub">${esc(u.lot)}</div>` : ''}${u.statut !== 'arrive' && u.prochain ? `<div class="sub">puis ${esc(u.prochain.client)} le ${dfr(u.prochain.debut)}</div>` : ''}</td>
      <td class="num">${u.loyer != null ? eur(u.loyer) : '–'}</td><td class="num">${u.prix_grille != null ? eur0(u.prix_grille) : '–'}</td></tr>`).join('')
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
  if (!OCC || (OCC.chargement && !OCC.inst)) return `<div class="center"><div class="big-spin"></div><p>Chargement…</p></div>`;
  const I = OCC.inst, K = I?.donnees?.clients;
  const etatArchie = OCC.maj
    ? `<span class="maj"><span class="spin"></span> Lecture d'Archie — <span id="occ-progression">${esc(OCC.progression || '')}</span></span>`
    : OCC.erreurMaj ? `<span class="maj ko">Archie non relu : ${esc(OCC.erreurMaj)}</span>` : '';
  let h = `<div class="etat">${I?.calcule_le && K ? `<span>Calculé le <b>${esc(quand(new Date(I.calcule_le)))}</b>${I.par ? ` par ${esc(I.par)}` : ''}</span>` : '<span>Pas encore calculé</span>'}
    ${etatArchie}<button class="btn sm" id="b-occ-actualiser" ${OCC.maj ? 'disabled' : ''}>Actualiser</button></div>`;
  if (!K) return h + `<div class="empty">Lecture d'Archie en cours (environ 20 secondes)…</div>`;
  const loyer = K.reduce((s, c) => s + c.loyer, 0);
  const avecHausse = K.filter((c) => c.prochaine_hausse).length;
  const imp = impayes();
  const nImp = K.filter((c) => imp.has(normNom(c.nom))).length;
  h += `<div class="resume">
    <div><div class="n">${K.length}</div><div class="l">clients avec un contrat en cours ou à venir</div></div>
    <div><div class="n">${eur0(loyer)}</div><div class="l">loyers HT du mois</div></div>
    <div><div class="n">${avecHausse}</div><div class="l">avec une hausse programmée dans Archie</div></div>
    <div><div class="n">${REC?.R ? nImp : '…'}</div><div class="l">au niveau 5 de relance</div></div></div>
    <div class="outils">
    <span class="tri">${[['tous', 'Tous'], ...BATIMENTS.map((b) => [b.code, b.code])].map(([k, t]) => `<button class="${CLI_BAT === k ? 'on' : ''}" data-cbat="${k}">${t}</button>`).join('')}</span>
    <span class="tri">Trier par ${[['loyer', 'loyer'], ['nom', 'nom'], ['depuis', 'ancienneté'], ['hausse', 'prochaine hausse']].map(([k, t]) => `<button class="${CLI_TRI === k ? 'on' : ''}" data-ctri="${k}">${t}</button>`).join('')}</span>
    <input class="search" id="cq" placeholder="Rechercher un client, un bureau, un email…" value="${esc(CLI_Q)}"></div>
    <div class="tablewrap"><table class="clients"><thead><tr><th>Client</th><th>Bâtiments</th><th>Bureaux et services</th><th class="num">Loyer HT / mois</th><th>Client depuis</th><th>Prochaine hausse</th><th class="num">Impayé niv. 5</th></tr></thead><tbody id="cclients"></tbody></table></div>
    <div style="height:60px"></div>`;
  return h;
}

function lignesClients() {
  const K = OCC?.inst?.donnees?.clients; if (!K || !$('#cclients')) return;
  document.querySelectorAll('[data-cbat]').forEach((b) => b.classList.toggle('on', b.dataset.cbat === CLI_BAT));
  document.querySelectorAll('[data-ctri]').forEach((b) => b.classList.toggle('on', b.dataset.ctri === CLI_TRI));
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
    <td><button class="lien client" data-fiche="${esc(c.cle)}">${ouvert ? '▾' : '▸'} ${esc(c.nom)}</button>${c.particulier ? '<span class="tag">particulier</span>' : ''}</td>
    <td>${esc(c.batiments.join(' + '))}</td>
    <td>${c.bureaux.length ? `<b>${esc(c.bureaux.join(', '))}</b>` : ''}${services.length ? `<div class="sub">${esc(services.join(' · '))}</div>` : ''}</td>
    <td class="num"><b>${eur(c.loyer)}</b>${c.loyer_a_venir ? `<div class="sub">+ ${eur0(c.loyer_a_venir)} à venir</div>` : ''}</td>
    <td>${c.depuis ? dfr(c.depuis) : '–'}${c.fin ? `<div class="sub">fin ${dfr(c.fin)}</div>` : ''}</td>
    <td>${h ? `${dfr(h.date)}<div class="sub">${h.pct > 0 ? '+' : ''}${h.pct} %</div>` : '<span class="sub">–</span>'}</td>
    <td class="num">${impaye ? `<span class="neg"><b>${eur0(impaye.total)}</b></span><div class="sub">${impaye.retard_max} j de retard</div>` : '<span class="sub">–</span>'}</td>
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
  if (!OCC || (OCC.chargement && !OCC.inst)) return `<div class="center"><div class="big-spin"></div><p>Chargement…</p></div>`;
  const I = OCC.inst, RV = lignesRevalo();
  const etatArchie = OCC.maj
    ? `<span class="maj"><span class="spin"></span> Lecture d'Archie — <span id="occ-progression">${esc(OCC.progression || '')}</span></span>`
    : OCC.erreurMaj ? `<span class="maj ko">Archie non relu : ${esc(OCC.erreurMaj)}</span>` : '';
  let h = `<div class="etat">${I?.calcule_le && RV ? `<span>Calculé le <b>${esc(quand(new Date(I.calcule_le)))}</b>${I.par ? ` par ${esc(I.par)}` : ''}</span>` : '<span>Pas encore calculé</span>'}
    ${etatArchie}<button class="btn sm" id="b-occ-actualiser" ${OCC.maj ? 'disabled' : ''}>Actualiser</button></div>`;
  if (!RV) return h + `<div class="empty">Lecture d'Archie en cours (environ 20 secondes)…</div>`;
  const nRegles = RV.filter((r) => r.regle).length;
  h += `<div class="info">Lecture seule. Calendrier des prix d'Archie, complété par les règles du classeur « Recap +3% Contrats »${REGLES ? ` (${REGLES.length} lignes, rapprochées de ${nRegles} contrats)` : ' (chargement…)'} : préavis, blocages, plafond et dates de dernière augmentation, y compris celles faites en réduisant une remise.</div>`;

  const bureaux = RV.filter((r) => r.cat === 'bureaux');
  const n = (s, l = bureaux) => l.filter((r) => r.statut === s);
  const somme = (l) => l.reduce((s, r) => s + r.gain, 0);
  h += `<div class="resume">
    <div><div class="n neg">${n('en_retard').length}</div><div class="l">bureaux en retard · +${eur0(somme(n('en_retard')))} / mois à +3 %</div></div>
    <div><div class="n">${n('a_programmer').length + n('a_prevenir').length}</div><div class="l">à programmer ou à prévenir</div></div>
    <div><div class="n pos">${n('programmee').length}</div><div class="l">hausses programmées · +${eur0(somme(n('programmee')))} / mois</div></div>
    <div><div class="n">${n('a_jour').length}</div><div class="l">bureaux à jour</div></div>
    <div><div class="n">${n('bloquee').length}</div><div class="l">bloqués (contrat, plafond)</div></div></div>`;

  // calendrier des 12 prochains mois (tous contrats) : hausses programmées et anniversaires sans hausse programmée
  const auj = I.donnees.aujourdhui || aujourdhuiParis();
  const mois = Array.from({ length: 12 }, (_, i) => ajouterMois(auj.slice(0, 7) + '-01', i).slice(0, 7));
  const parMois = (s) => Object.fromEntries(mois.map((m) => [m, RV.filter((r) => r.statut === s && r.anniversaire?.slice(0, 7) === m)]));
  const P = parMois('programmee'), A = { ...Object.fromEntries(mois.map((m) => [m, []])) };
  for (const r of RV) if ((r.statut === 'a_prevenir' || r.statut === 'a_jour') && A[r.anniversaire?.slice(0, 7)]) A[r.anniversaire.slice(0, 7)].push(r);
  const libMois = (m) => `${MOIS[Number(m.slice(5)) - 1]} ${m.slice(2, 4)}`;
  h += `<h3 class="titre">Les 12 prochains mois <span class="sub">(tous contrats)</span></h3><div class="tablewrap"><table class="synth"><thead><tr><th></th>${mois.map((m) => `<th class="num">${libMois(m)}</th>`).join('')}</tr></thead><tbody>
    <tr><td>Hausses programmées</td>${mois.map((m) => `<td class="num">${P[m].length || '–'}</td>`).join('')}</tr>
    <tr><td class="sub">gain mensuel</td>${mois.map((m) => `<td class="num pos">${P[m].length ? '+' + eur0(somme(P[m])) : ''}</td>`).join('')}</tr>
    <tr><td>Anniversaires sans hausse programmée</td>${mois.map((m) => `<td class="num">${A[m].length || '–'}</td>`).join('')}</tr>
    </tbody></table></div>`;

  h += `<h3 class="titre">Contrats</h3><div class="outils">
    <span class="tri">${[['a_traiter', 'À traiter'], ['en_retard', 'En retard'], ['a_programmer', 'À programmer'], ['a_prevenir', 'À prévenir'], ['programmee', 'Programmées'], ['a_jour', 'À jour'], ['bloquee', 'Bloquées'], ['tous', 'Tous']].map(([k, t]) => `<button data-rstatut="${k}">${t}</button>`).join('')}</span>
    <span class="tri">${[['bureaux', 'Bureaux'], ['coresidents', 'Co-résidents'], ['itinerants', 'Itinérants'], ['parking', 'Parking'], ['domiciliation', 'Domiciliation'], ['tous', 'Tout']].map(([k, t]) => `<button data-rcat="${k}">${t}</button>`).join('')}</span>
    <span class="tri">${[['tous', 'Tous'], ...BATIMENTS.map((b) => [b.code, b.code])].map(([k, t]) => `<button data-rbat="${k}">${t}</button>`).join('')}</span>
    <input class="search" id="rq" placeholder="Rechercher un client, un bureau…" value="${esc(RV_Q)}"></div>
    <div class="sub" id="rv-compte"></div>
    <div class="tablewrap"><table class="clients"><thead><tr><th>Statut</th><th>Client</th><th>Contrat</th><th>Bât.</th><th class="num">Loyer HT</th><th>Dernière hausse</th><th>Prochaine hausse</th><th class="num">Gain / mois</th></tr></thead><tbody id="rcontrats"></tbody></table></div>
    <div style="height:60px"></div>`;
  return h;
}

function lignesRevaloTable() {
  const RV = lignesRevalo(); if (!RV || !$('#rcontrats')) return;
  document.querySelectorAll('[data-rstatut]').forEach((b) => b.classList.toggle('on', b.dataset.rstatut === RV_STATUT));
  document.querySelectorAll('[data-rcat]').forEach((b) => b.classList.toggle('on', b.dataset.rcat === RV_CAT));
  document.querySelectorAll('[data-rbat]').forEach((b) => b.classList.toggle('on', b.dataset.rbat === RV_BAT));
  const q = RV_Q.trim().toLowerCase();
  const ordre = { en_retard: 0, a_programmer: 1, a_prevenir: 2, programmee: 3, a_jour: 4, bloquee: 5, se_termine: 6 };
  const L = RV.filter((r) => (RV_STATUT === 'tous' || r.statut === RV_STATUT || (RV_STATUT === 'a_traiter' && A_TRAITER.has(r.statut)))
    && (RV_CAT === 'tous' || r.cat === RV_CAT) && (RV_BAT === 'tous' || r.batiment === RV_BAT)
    && (!q || [r.client, r.contrat, ...(r.bureaux || [])].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => ordre[a.statut] - ordre[b.statut] || (a.anniversaire || '9999').localeCompare(b.anniversaire || '9999'));
  $('#rv-compte').textContent = `${L.length} contrat${L.length > 1 ? 's' : ''} · +${eur0(L.reduce((s, r) => s + r.gain, 0))} / mois`;
  $('#rcontrats').innerHTML = L.length ? L.map((r) => {
    const prochaine = r.prochaine
      ? `${dfr(r.prochaine.date)} · ${r.prochaine.pct > 0 ? '+' : ''}${r.prochaine.pct} %<div class="sub">${eur(r.prochaine.de)} → ${eur(r.prochaine.a)} (prix de base)</div>`
      : r.statut === 'en_retard' ? `<span class="neg">anniversaire passé le ${dfr(r.anniversaire)}</span>`
        : r.statut === 'se_termine' ? `<span class="sub">fin du contrat le ${dfr(r.fin)}</span>`
          : r.statut === 'bloquee' ? `<span class="sub">${esc(r.motif)}</span>`
            : r.statut === 'a_programmer' ? `<span class="neg">${dfr(r.anniversaire)} : notifiée, absente d'Archie</span>`
              : `<span class="sub">anniversaire le ${dfr(r.anniversaire)}</span>`;
    const obs = r.regle?.observations;
    return `<tr>
      <td><span class="statut rv-${r.statut}">${RV_STATUTS[r.statut]}</span>${r.regle?.preavis_mois >= 2 ? '<div class="sub">préavis 2 mois</div>' : ''}</td>
      <td><b>${esc(r.client)}</b></td>
      <td>${esc(r.contrat)}${r.remise ? `<div class="sub">remise ${r.remise} %${r.fin_remise ? ` jusqu'au ${dfr(r.fin_remise)}` : ''}</div>` : ''}${r.fin && r.statut !== 'se_termine' ? `<div class="sub">fin du contrat le ${dfr(r.fin)}</div>` : ''}${obs ? `<div class="obs" title="${esc(obs)}">${esc(obs.length > 140 ? obs.slice(0, 140) + '…' : obs)}</div>` : ''}</td>
      <td>${esc(r.batiment)}</td>
      <td class="num">${eur(r.loyer)}</td>
      <td>${r.derniere ? `${dfr(r.derniere)}${r.derniere_source === 'classeur' ? '<div class="sub">selon le classeur</div>' : ''}` : `<span class="sub">aucune depuis le ${dfr(r.debut)}</span>`}</td>
      <td>${prochaine}</td>
      <td class="num">${r.gain ? '+' + eur(r.gain) : '–'}</td></tr>`;
  }).join('') : '<tr><td colspan="8" class="empty">Aucun contrat ne correspond.</td></tr>';
}

// ---------------------------------------------------------------------------- plan
// Plans d'étage reproduits d'après les onglets « Réf. TB1..TB4 » du classeur « TB - The Bureau » (géométrie en base,
// fonction « tableau ») : une case du classeur = une unité. Chaque bureau (zone colorée de l'Excel) prend la couleur
// de son occupation calculée depuis Archie (onglet Occupation), avec la légende de l'Excel.
const PLAN_STATUTS = { occupe: 'Occupé', se_libere: 'Sur le départ', arrive: 'Signé', libre: 'Libre', inconnu: 'Non trouvé dans Archie', attente: 'Occupation en cours de chargement' };
const PLAN_COUL = { occupe: ['#EF8080', '#7F1D1D'], se_libere: ['#F8B4A0', '#9A3412'], arrive: ['#C4EDB0', '#166534'], libre: ['#7CCF8E', '#14532D'], inconnu: ['#FFFFFF', '#6B7280'], attente: ['#F3F4F6', '#6B7280'] };
const normCode = (s) => String(s ?? '').toUpperCase().replace(/\s+/g, '');
const coulPlan = (c) => (/^[0-9A-Fa-f]{6}$/.test(String(c)) ? '#' + c : '#D9DCE1'); // couleur lue en base : six chiffres hexadécimaux, sinon gris
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

/** Découpe un libellé en lignes tenant dans la largeur w (unités du plan) pour une taille de police fs. */
function lignesTexte(t, w, fs) {
  const max = Math.max(3, Math.floor(w / (fs * 0.56)));
  if (t.length <= max) return [t];
  const out = []; let cur = '';
  const mots = t.split(/\s+/).reduce((a, m) => { if (m === '·' && a.length) a[a.length - 1] += ' ·'; else a.push(m); return a; }, []);
  for (const mot of mots) {
    if (cur && (cur + ' ' + mot).length > max) { out.push(cur); cur = mot; } else cur = cur ? cur + ' ' + mot : mot;
  }
  if (cur) out.push(cur);
  return out;
}

/** Texte SVG centré (ou aligné à gauche) dans une boîte, sur une ou plusieurs lignes. */
function texteBoite(x, y, w, h, t, fs, attrs, centre = true) {
  const L = centre ? lignesTexte(t, w, fs) : [t];
  const y0 = y + h / 2 - ((L.length - 1) * fs * 1.1) / 2;
  const ax = centre ? x + w / 2 : x + 0.3;
  return `<text x="${ax.toFixed(2)}" y="${y0.toFixed(2)}" style="font-size:${fs.toFixed(2)}px" text-anchor="${centre ? 'middle' : 'start'}" dominant-baseline="central" ${attrs}>${L.map((l, i) => `<tspan x="${ax.toFixed(2)}" dy="${i ? (fs * 1.1).toFixed(2) : 0}">${esc(l)}</tspan>`).join('')}</text>`;
}

function vuePlan() {
  if (!PLANS) return `<div class="center"><div class="big-spin"></div><p>Chargement des plans…</p></div>`;
  if (!PLANS.length) return `<div class="empty">Aucun plan enregistré.</div>`;
  const P = PLANS.find((p) => p.batiment === PLAN_BAT) || PLANS[0];
  if (!P.etages?.[0]?.fonds) return `<div class="empty">Plans en cours de mise à jour, rechargez la page dans un instant.</div>`;
  const B = BATIMENTS.find((b) => b.code === P.batiment);
  const occ = OCC?.inst?.donnees;
  let h = `<div class="outils" style="margin-top:16px"><span class="tri">${PLANS.map((p) => `<button class="${p.batiment === P.batiment ? 'on' : ''}" data-pbat="${p.batiment}">${p.batiment}</button>`).join('')}</span>
    <span class="sub">${esc(B?.nom || '')}${occ ? ` · occupation calculée le ${esc(quand(new Date(OCC.inst.calcule_le)))}` : ' · occupation en cours de chargement'}</span></div>
    <div class="legende">${['occupe', 'se_libere', 'arrive', 'libre'].map((s) => `<span><i style="background:${PLAN_COUL[s][0]}"></i>${PLAN_STATUTS[s]}</span>`).join('')}<span><i style="background:#DCE6F1"></i>Salle de réunion</span></div>
    <div id="plan-choix"></div>`;
  const largeurMax = Math.max(...P.etages.map((e) => e.l)); // même échelle pour tous les étages du bâtiment
  for (const e of P.etages) {
    let occupes = 0, libres = 0;
    const fonds = e.fonds.map(([x, y, w, hh, c]) => `<rect x="${Number(x)}" y="${Number(y)}" width="${Number(w)}" height="${Number(hh)}" fill="${coulPlan(c)}"/>`).join('');
    const textes = e.textes.map(([x, y, w, hh, t, c, sz, b, fusion]) =>
      texteBoite(Number(x), Number(y), Number(w), Number(hh), String(t), (Number(sz) || 11) * 0.2, `fill="${coulPlan(c)}"${b ? ' font-weight="700"' : ''}`, !!fusion)).join('');
    const bureaux = e.bureaux.map((z) => {
      const s = etatZone(z.code, P.batiment);
      const st = s?.statut || (occ ? 'inconnu' : 'attente');
      // compteur de l'étage comme dans l'Excel : en bureaux (postes de co-résident non comptés, « A404-405 » = 2)
      const nb = nbBureauxZone(z.code);
      if (st === 'occupe' || st === 'se_libere') occupes += nb; else if (st === 'libre' || st === 'arrive') libres += nb;
      const [fond, encre] = PLAN_COUL[st];
      const cle = `${P.batiment}|${z.code}`;
      let [lx, ly, lw, lh] = z.lab || [0, 0, 0, 0];
      if (!z.lab) { // pas de libellé dans l'Excel : boîte englobante de la zone
        const x0 = Math.min(...z.r.map((q) => q[0])), y0 = Math.min(...z.r.map((q) => q[1]));
        lx = x0; ly = y0; lw = Math.max(...z.r.map((q) => q[0] + q[2])) - x0; lh = Math.max(...z.r.map((q) => q[1] + q[3])) - y0;
      }
      // taille du code : celle de l'Excel (2,3), réduite seulement si le code ne tient pas dans son libellé
      const fs = Math.min(2.3, lw / (0.68 * Math.max(3, String(z.code).length)), lh / 1.3);
      const avecClient = s?.client && lh >= 6 && lw >= 9;
      const maxc = Math.max(4, Math.floor(lw / (fs * 0.42)));
      const client = avecClient ? `<text x="${(lx + lw / 2).toFixed(2)}" y="${(ly + lh / 2 + fs * 0.75).toFixed(2)}" text-anchor="middle" dominant-baseline="central" fill="${encre}" style="font-size:${(fs * 0.62).toFixed(2)}px">${esc(s.client.length > maxc ? s.client.slice(0, maxc - 1) + '…' : s.client)}</text>` : '';
      return `<g class="pz${PLAN_CHOIX === cle ? ' choisi' : ''}" data-pz="${esc(cle)}"><title>${esc(z.code)} · ${esc(PLAN_STATUTS[st])}${s?.client ? ' · ' + esc(s.client) : ''}</title>
        ${z.r.map(([x, y, w, hh]) => `<rect x="${Number(x)}" y="${Number(y)}" width="${Number(w)}" height="${Number(hh)}" fill="${fond}"${st === 'inconnu' ? ' stroke="#9CA3AF" stroke-width=".25" stroke-dasharray=".8 .5"' : ''}/>`).join('')}
        <text x="${(lx + lw / 2).toFixed(2)}" y="${(ly + lh / 2 - (client ? fs * 0.35 : 0)).toFixed(2)}" text-anchor="middle" dominant-baseline="central" font-weight="700" fill="${encre}" style="font-size:${fs.toFixed(2)}px">${esc(z.code)}</text>${client}</g>`;
    }).join('');
    h += `<div class="etage"><div class="etage-t"><b>${esc(e.titre)}</b> <span class="sub">Occupés ${occupes} · Libres ${libres}</span></div>
      <svg class="plan" viewBox="-0.5 -0.5 ${Number(e.l) + 1} ${Number(e.h) + 1}" preserveAspectRatio="xMinYMin meet" style="width:${(100 * e.l / largeurMax).toFixed(1)}%;max-width:${Math.round(e.l * 8)}px">${fonds}${bureaux}${textes}</svg></div>`;
  }
  return h + '<div style="height:60px"></div>';
}

/** Détail du bureau cliqué (sans redessiner le plan). */
function afficherChoixPlan() {
  document.querySelectorAll('.pz').forEach((g) => g.classList.toggle('choisi', g.dataset.pz === PLAN_CHOIX));
  const el = $('#plan-choix'); if (!el) return;
  if (!PLAN_CHOIX) { el.innerHTML = ''; return; }
  const [bat, code] = PLAN_CHOIX.split('|');
  const s = etatZone(code, bat) || { statut: 'inconnu' };
  const rv = (lignesRevalo() || []).find((r) => r.batiment === bat && r.client === s.client && (r.bureaux || []).some((b) => normCode(b) === normCode(s.nom)));
  el.innerHTML = `<div class="choix"><b>${esc(code)}</b> <span class="statut ${s.statut === 'inconnu' ? '' : s.statut}">${esc(PLAN_STATUTS[s.statut])}${s.date ? ' ' + dfr(s.date) : ''}</span>
    ${s.client ? ` · <b>${esc(s.client)}</b>` : ''}${s.loyer != null ? ` · ${eur(s.loyer)} HT / mois` : ''}${s.surface ? ` · ${m2(s.surface)}` : ''}${s.postes ? ` · ${s.postes} postes` : ''}
    ${s.fin ? `<div class="sub">Fin du contrat le ${dfr(s.fin)}</div>` : ''}${s.prochain ? `<div class="sub">Puis ${esc(s.prochain.client)} le ${dfr(s.prochain.debut)}</div>` : ''}
    ${rv ? `<div class="sub">Revalorisation : ${esc(RV_STATUTS[rv.statut])}${rv.prochaine ? ` · ${dfr(rv.prochaine.date)} +${rv.prochaine.pct} %` : rv.anniversaire ? ` · anniversaire le ${dfr(rv.anniversaire)}` : ''}</div>` : ''}</div>`;
}
