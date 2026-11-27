// Page « Suivi niveau 5 » (Oscar, Charles) : séparée de l'écran de pointage, lecture seule.
// Affiche tout de suite le dernier calendrier enregistré, puis relit les factures ouvertes dans Archie en arrière-plan.
// Deux façons d'y accéder :
//   • par lien (…/suivi.html#cle=…) : aucune connexion ; la fonction « suivi » vérifie la clé et ne renvoie que le niveau 5 ;
//   • connecté avec un compte @thebureau.paris.
import * as D from './relances-donnees.js?v=20261127-10';
import * as RL from './relances.js?v=20261127-10';

const C = window.CONFIG || {};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (v) => Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const eur0 = (v) => Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' €';
const dfr = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '');
const dcourt = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) : '');
const quand = (d) => `${d.toLocaleDateString('fr-FR')} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
const estMembre = (e) => String(e || '').toLowerCase().endsWith('@' + C.DOMAINE);

let sb = null, USER = null, courant;
let ETAT = null; // { R, chargement, maj, progression, erreur, erreurMaj }
let TRI = 'retard', Q = '';
const AUTO_MIN = 10; // minutes entre deux mises à jour automatiques
const OUVERTS = new Set(); // clients dont la liste de factures est dépliée
const CLE = new URLSearchParams(location.hash.slice(1)).get('cle'); // ancien lien avec clé (toujours accepté)
// Trois façons d'obtenir les données, essayées dans cet ordre :
//   'cle'     : l'adresse contient une clé de lien ;
//   'public'  : la page est ouverte à tous (paramètre suivi_public, décidé par Charles) — ni clé, ni connexion ;
//   'session' : la page n'est pas publique → connexion avec un compte autorisé.
let MODE = CLE ? 'cle' : 'public';

// ---------------------------------------------------------------------------- données : toujours par la fonction « suivi »
/** Appelle la fonction « suivi » selon le mode d'accès. Elle ne renvoie que les clients au niveau 5. */
async function appelSuivi(quoi) {
  const headers = { 'Content-Type': 'application/json', apikey: C.SUPABASE_ANON_KEY };
  const corps = { quoi };
  if (MODE === 'cle') corps.cle = CLE;
  else if (MODE === 'session') {
    const { data } = await sb.auth.getSession();
    if (!data.session) { const e = new Error('Session expirée : reconnectez-vous.'); e.statut = 401; throw e; }
    headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  const r = await fetch(`${C.SUPABASE_URL}/functions/v1/suivi`, { method: 'POST', headers, body: JSON.stringify(corps) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || `Erreur ${r.status}`); e.statut = r.status; throw e; }
  return { ...j, calcule_le: j.calcule_le ? new Date(j.calcule_le) : null };
}
/** Accès refusé : lien révoqué ou inconnu, page non publique, ou session qui n'est plus valable. */
function accesRefuse(e) {
  if (![400, 401, 403].includes(e.statut)) return false;
  ETAT = null;
  if (MODE === 'cle') $('#main').innerHTML = `<div class="center"><h2>Lien non valide</h2><p>${esc(e.message)}</p></div>`;
  else if (MODE === 'public') demarrerConnexion(); // la page n'est pas (ou plus) publique : accès par compte autorisé
  else vueConnexion(e.message);
  return true;
}
async function demarrer() {
  ETAT = { R: null, chargement: true, maj: false };
  rendu();
  const etat = ETAT;
  try { etat.R = await appelSuivi('donnees'); } catch (e) { if (accesRefuse(e)) return; etat.erreur = e.message; }
  if (ETAT !== etat) return;
  etat.chargement = false;
  rendu();
  actualiser();
}
async function actualiser() {
  const etat = ETAT;
  if (!etat || etat.maj) return;
  const debut = Date.now(), parPas = D.memoire.lire('sec_actualisation_lien', 12);
  const maj = () => {
    etat.progression = `Lecture d'Archie · ${D.estimation(debut, 0, 1, parPas)}`;
    const e = $('#progression'); if (e && ETAT === etat) e.textContent = etat.progression;
  };
  etat.maj = true; etat.erreurMaj = null; etat.dernierEssai = Date.now(); maj(); rendu();
  const tic = setInterval(maj, 1000);
  try {
    const R = await appelSuivi('actualiser');
    D.memoire.ecrire('sec_actualisation_lien', ((Date.now() - debut) / 1000).toFixed(1));
    if (ETAT !== etat) return;
    etat.R = R; etat.erreur = null;
  } catch (e) {
    if (accesRefuse(e)) return;
    etat.erreurMaj = e.message;
  } finally { clearInterval(tic); }
  etat.maj = false;
  if (ETAT === etat) rendu();
}

// ---------------------------------------------------------------------------- connexion (accès sans lien)
function vueConnexion(msg) {
  USER = null; ETAT = null; courant = undefined; $('#b-out').hidden = true; $('#who').textContent = '';
  $('#main').innerHTML = `<div class="center"><h2>Connexion</h2><p>Saisissez votre adresse @${esc(C.DOMAINE)} : un lien de connexion vous sera envoyé.</p>
    <form class="form" id="f-login">
      <input id="email" type="email" autocomplete="email" placeholder="prenom@${esc(C.DOMAINE)}" required>
      <button class="btn primary" id="b-login">Recevoir le lien de connexion</button>
      <div class="err" id="err">${esc(msg || '')}</div>
    </form></div>`;
  $('#f-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim().toLowerCase();
    if (!estMembre(email)) { $('#err').textContent = `Adresse @${C.DOMAINE} uniquement.`; return; }
    $('#b-login').disabled = true; $('#err').textContent = '';
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) { $('#b-login').disabled = false; $('#err').textContent = error.message; return; }
    $('#main').innerHTML = `<div class="center"><h2>Lien envoyé</h2><p>Ouvrez l'email reçu à <b>${esc(email)}</b> et cliquez sur le lien pour vous connecter.</p></div>`;
  });
}

async function afficher(session) {
  const user = session && session.user;
  if ((user ? user.id : null) === courant) return;
  courant = user ? user.id : null;
  if (!user) return vueConnexion();
  if (!estMembre(user.email)) { await sb.auth.signOut(); return vueConnexion(`Adresse @${C.DOMAINE} uniquement.`); }
  USER = user;
  $('#who').textContent = user.email; $('#b-out').hidden = false;
  await demarrer();
}

// ---------------------------------------------------------------------------- rendu
function rendu() {
  const m = $('#main');
  if (!ETAT) return;
  if (ETAT.chargement && !ETAT.R) { m.innerHTML = `<div class="center"><div class="big-spin"></div><p>Chargement…</p></div>`; return; }
  const R = ETAT.R;
  const etatArchie = ETAT.maj
    ? `<span class="maj"><span class="spin"></span> Mise à jour depuis Archie — <span id="progression">${esc(ETAT.progression || '')}</span></span>`
    : ETAT.erreurMaj ? `<span class="maj ko">Archie non relu : ${esc(ETAT.erreurMaj)}</span>` : '';
  // une mise à jour (automatique ou non) ne doit ni faire sauter la page, ni interrompre une recherche en cours de frappe
  const defilement = window.scrollY, recherche = document.activeElement?.id === 'q' ? document.activeElement.selectionStart : null;
  let h = `<div class="etat">${R?.calcule_le ? `<span>Dernière mise à jour : <b>${esc(quand(R.calcule_le))}</b></span>` : '<span>Aucune donnée enregistrée</span>'}
    ${etatArchie}<button class="btn sm" onclick="S.actualiser()" ${ETAT.maj ? 'disabled' : ''}>Actualiser</button>
    <span>· mise à jour automatique toutes les ${AUTO_MIN} minutes</span></div>`;
  if (ETAT.erreur && !R) { m.innerHTML = h + `<div class="empty">Chargement impossible : ${esc(ETAT.erreur)}</div>`; return; }
  if (!R) { m.innerHTML = h + `<div class="empty">Lecture d'Archie en cours…</div>`; return; }

  if (!R.actives) h += `<div class="info">Les relances automatiques ne sont pas encore activées : le niveau 5 est estimé d'après le retard de la facture la plus ancienne de chaque client (niveau 4 à J+14, niveau 5 trois jours ouvrés plus tard).</div>`;
  const tous = R.clients;
  h += `<div class="resume"><div><div class="n">${tous.length}</div><div class="l">clients au niveau 5</div></div>
    <div><div class="n">${eur0(tous.reduce((s, c) => s + c.total, 0))}</div><div class="l">restant dû</div></div>
    <div><div class="n">${tous.reduce((s, c) => s + c.factures.length, 0)}</div><div class="l">factures</div></div>
    ${tous.some((c) => c.avoirs?.length) ? `<div><div class="n">${tous.filter((c) => c.avoirs?.length).length}</div><div class="l">avec un avoir disponible</div></div>` : ''}</div>
    <div class="outils"><input class="search" id="q" placeholder="Rechercher un client, un email, une facture…" value="${esc(Q)}">
    <span class="tri" id="tri"></span></div>
    <table><thead><tr><th>Retard</th><th>Client</th><th class="num">Relances</th><th>Contact</th><th class="num">Montant dû</th></tr></thead><tbody id="corps"></tbody></table><div style="height:60px"></div>`;
  m.innerHTML = h;
  $('#q').addEventListener('input', (e) => { Q = e.target.value; tableau(); });
  tableau();
  if (recherche !== null) { const q = $('#q'); q.focus(); q.setSelectionRange(recherche, recherche); }
  window.scrollTo(0, defilement);
}

/** Lignes du tableau (recherche et tri sans redessiner la page). */
function tableau() {
  const R = ETAT?.R; if (!R || !$('#corps')) return;
  const tous = R.clients;
  const q = Q.trim().toLowerCase();
  const L = tous.filter((c) => !q || [c.client, c.manager, c.manager_email, ...c.contacts, ...c.factures.map((f) => f.ref)].join(' ').toLowerCase().includes(q));
  const cle = { retard: (c) => c.retard_max, montant: (c) => c.total, relances: (c) => c.relances.length };
  L.sort((a, b) => cle[TRI](b) - cle[TRI](a) || b.retard_max - a.retard_max);
  $('#tri').innerHTML = 'Trier par ' + [['retard', 'retard'], ['montant', 'montant'], ['relances', 'relances']].map(([k, t]) => `<button class="${TRI === k ? 'on' : ''}" onclick="S.trier('${k}')">${t}</button>`).join('');
  $('#corps').innerHTML = L.length ? L.map((c) => ligne(c, R)).join('')
    : `<tr><td colspan="5" class="empty">${tous.length ? 'Aucun client ne correspond à la recherche.' : 'Aucun client au niveau 5.'}</td></tr>`;
}

function ligne(c, R) {
  const depuis = Math.max(0, RL.ecartJours(R.aujourdhui, c.date_niveau5));
  const classe = c.retard_max >= 60 ? 'max' : c.retard_max >= 30 ? 'fort' : '';
  const derniere = c.relances.length ? c.relances[c.relances.length - 1] : null;
  // contacts de facturation (destinataires des relances), puis le responsable s'il n'en fait pas partie
  const emails = (c.contacts || []).map((e) => [e, '']);
  if (c.manager_email && !(c.contacts || []).includes(c.manager_email)) emails.push([c.manager_email, 'responsable']);
  const avoir = c.avoirs?.length
    ? `<div class="avoir ${c.couverture === 'totale' ? 'tout' : ''}">Avoir disponible ${eur(c.total_avoirs)}<div class="sub">${c.couverture === 'totale' ? 'solde tout l\'impayé' : c.couverture === 'partielle' ? `peut solder ${eur(c.avoirs_imputables)}` : 'autre société'} · ${c.avoirs.map((a) => esc(a.ref || 'avoir')).join(', ')}</div></div>` : '';
  const facs = c.factures.map((f) => `<li>${esc(f.ref)} · ${esc(f.site)} · échéance ${dfr(f.echeance)} · ${eur(f.reste)}</li>`).join('');
  return `<tr>
    <td data-l="Retard" class="c-retard"><span class="compteur ${classe}"><span class="v">${c.retard_max}</span> j</span>
      <div class="sub" style="margin-top:4px">niveau 5 depuis ${depuis} j${c.date_niveau5 ? ` (${dcourt(c.date_niveau5)})` : ''}</div></td>
    <td data-l="Client" class="c-client"><div class="client">${esc(c.client)}${c.particulier ? '<span class="tag">particulier</span>' : ''}</div>
      <details data-c="${esc(c.client)}" ${OUVERTS.has(c.client) ? 'open' : ''}><summary>${c.factures.length} facture${c.factures.length > 1 ? 's' : ''} · ${esc(c.sites.join(' + '))}</summary><ul>${facs}</ul></details></td>
    <td data-l="Relances" class="num relances c-rel"><div class="v">${c.relances.length}</div><div class="sub">${derniere ? `dernière le ${dfr(derniere)}` : 'aucune'}</div></td>
    <td data-l="Contact" class="contact c-contact">${c.manager ? `<div>${esc(c.manager)}</div>` : ''}
      ${emails.map(([e, role]) => `<div><a href="mailto:${esc(e)}">${esc(e)}</a>${role ? ` <span class="sub">(${role})</span>` : ''}</div>`).join('') || '<span class="sub">aucun email dans Archie</span>'}</td>
    <td data-l="Montant dû" class="num c-montant"><div class="montant">${eur(c.total)}</div>${avoir}</td>
  </tr>`;
}

window.S = {
  actualiser: () => actualiser(),
  trier: (k) => { TRI = k; tableau(); },
};

// ---------------------------------------------------------------------------- mise à jour automatique
// Tant que la page est ouverte et visible, Archie est relu toutes les AUTO_MIN minutes ; au retour sur l'onglet aussi si
// les données ont vieilli. (Le serveur limite de toute façon à une relecture par minute, quel que soit le nombre de pages ouvertes.)
// (on compte depuis la dernière tentative, réussie ou non : en cas de panne d'Archie, pas de nouvel essai toutes les 30 secondes)
const perimees = () => Date.now() - (ETAT?.dernierEssai || 0) >= AUTO_MIN * 60000 - 5000;
setInterval(() => { if (document.visibilityState === 'visible' && ETAT && !ETAT.chargement && !ETAT.maj && perimees()) actualiser(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ETAT && !ETAT.chargement && !ETAT.maj && perimees()) actualiser(); });
// listes de factures dépliées : conservées d'une mise à jour à l'autre
document.addEventListener('toggle', (e) => { const c = e.target?.dataset?.c; if (c) { if (e.target.open) OUVERTS.add(c); else OUVERTS.delete(c); } }, true);

/** Accès par compte (seulement si la page n'est pas publique et qu'il n'y a pas de clé dans l'adresse). */
let connexionPrete = false;
async function demarrerConnexion() {
  MODE = 'session';
  if (!window.supabase) { $('#main').innerHTML = '<div class="center"><h2>Configuration en attente</h2></div>'; return; }
  if (!connexionPrete) {
    connexionPrete = true;
    sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
    $('#b-out').addEventListener('click', async () => { await sb.auth.signOut(); courant = null; vueConnexion(); });
    sb.auth.onAuthStateChange((evt, session) => { if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') afficher(session); });
  }
  const { data } = await sb.auth.getSession();
  await afficher(data.session);
}

(async function init() {
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY) { $('#main').innerHTML = '<div class="center"><h2>Configuration en attente</h2></div>'; return; }
  // avec une clé ou en accès public : ni connexion, ni compte affiché ; si la page n'est pas publique, demarrer() bascule sur la connexion
  await demarrer();
})();
