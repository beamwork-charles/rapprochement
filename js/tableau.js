// Tableau de bord The Bureau (Charles, Oscar) : page séparée de l'outil de pointage, lecture seule pour l'instant.
// Accès : mot de passe partagé (vérifié par la fonction « tableau », qui renvoie un jeton de 30 jours gardé dans ce
// navigateur), ou session d'un compte autorisé de l'outil de pointage (sans mot de passe).
// Toutes les données passent par la fonction « tableau » ; aucune clé ni donnée dans cette page.

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
  const compteur = { recouvrement: R ? String(R.clients.length) : '…' };
  const sous = { recouvrement: R ? `clients au niveau 5 · ${eur0(R.clients.reduce((s, c) => s + c.total, 0))}` : 'chargement' };
  return `<nav class="tiles">${ONGLETS.map((o) => `<a class="tile ${o.id} ${ONGLET === o.id ? 'on' : ''}" href="#${o.id}">
    <div class="t">${esc(o.titre)}</div><div class="n ${compteur[o.id] ? '' : 'vide'}">${esc(compteur[o.id] || '—')}</div>
    <div class="s">${esc(sous[o.id] || 'en préparation')}</div><div class="bar"></div></a>`).join('')}</nav>`;
}

function rendu() {
  if (!PRENOM) return;
  const m = $('#main');
  const defilement = window.scrollY, recherche = document.activeElement?.id === 'q' ? document.activeElement.selectionStart : null;
  let h = tuiles();
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
    <table><thead><tr><th>Retard</th><th>Client</th><th class="num">Relances</th><th>Contact</th><th class="num">Montant dû</th></tr></thead><tbody id="corps"></tbody></table><div style="height:60px"></div>`;
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
  const t = e.target.closest('[data-tri], #b-actualiser');
  if (!t) return;
  if (t.id === 'b-actualiser') actualiser();
  else { TRI = t.dataset.tri; lignes(); }
});
document.addEventListener('toggle', (e) => { const c = e.target?.dataset?.c; if (c) { if (e.target.open) OUVERTS.add(c); else OUVERTS.delete(c); } }, true);
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
