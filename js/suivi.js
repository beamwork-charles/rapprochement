// Page « Suivi niveau 5 » (Oscar, Charles) : séparée de l'écran de pointage, lecture seule.
// Affiche tout de suite le dernier calendrier enregistré, puis relit les factures ouvertes dans Archie en arrière-plan.
import * as D from './relances-donnees.js?v=20261126-14';
import * as RL from './relances.js?v=20261126-14';

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

async function appel(nom, body) {
  for (let essai = 0; ; essai++) {
    const { data, error } = await sb.functions.invoke(nom, { body });
    if (!error) return data;
    const statut = error.context?.status;
    if (essai < 2 && (!statut || statut === 546 || statut >= 502)) { await new Promise((r) => setTimeout(r, 1500 * (essai + 1))); continue; }
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error || j.message || msg; } catch { /* corps illisible */ }
    throw new Error(msg);
  }
}

// ---------------------------------------------------------------------------- connexion
function vueConnexion(msg) {
  USER = null; ETAT = null; $('#b-out').hidden = true; $('#who').textContent = '';
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

// ---------------------------------------------------------------------------- données
async function demarrer() {
  ETAT = { R: null, chargement: true, maj: false };
  rendu();
  const etat = ETAT;
  try {
    const [ctx, enr] = await Promise.all([D.contexte(sb), D.lireEnregistre(sb)]);
    if (ETAT !== etat) return;
    if (enr.factures.length) etat.R = D.calculer(enr.factures, ctx, enr.calcule_le);
  } catch (e) { etat.erreur = e.message; }
  etat.chargement = false;
  rendu();
  actualiser();
}

async function actualiser() {
  const etat = ETAT;
  if (!etat || etat.maj) return;
  etat.maj = true; etat.erreurMaj = null; etat.progression = "Lecture d'Archie…"; rendu();
  try {
    const factures = await D.lireOuvertes(appel, (texte) => {
      etat.progression = texte;
      const e = $('#progression'); if (e && ETAT === etat) e.textContent = texte;
    });
    const R = D.calculer(factures, await D.contexte(sb));
    if (ETAT !== etat) return;
    etat.R = R; etat.erreur = null;
    D.enregistrer(sb, R).catch((e) => console.warn('Calendrier non enregistré :', e.message));
  } catch (e) { etat.erreurMaj = e.message; }
  etat.maj = false;
  if (ETAT === etat) rendu();
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
  let h = `<div class="etat">${R ? `<span>Dernière mise à jour : <b>${esc(quand(R.calcule_le))}</b></span>` : '<span>Aucune donnée enregistrée</span>'}
    ${etatArchie}<button class="btn sm" onclick="S.actualiser()" ${ETAT.maj ? 'disabled' : ''}>Actualiser</button></div>`;
  if (ETAT.erreur && !R) { m.innerHTML = h + `<div class="empty">Chargement impossible : ${esc(ETAT.erreur)}</div>`; return; }
  if (!R) { m.innerHTML = h + `<div class="empty">Lecture d'Archie en cours…</div>`; return; }

  if (!R.actives) h += `<div class="info">Les relances automatiques ne sont pas encore activées : le niveau 5 est estimé d'après le retard de la facture la plus ancienne de chaque client (niveau 4 à J+14, niveau 5 trois jours ouvrés plus tard).</div>`;
  const tous = D.niveau5(R);
  h += `<div class="resume"><div><div class="n">${tous.length}</div><div class="l">clients au niveau 5</div></div>
    <div><div class="n">${eur0(tous.reduce((s, c) => s + c.total, 0))}</div><div class="l">restant dû</div></div>
    <div><div class="n">${tous.reduce((s, c) => s + c.factures.length, 0)}</div><div class="l">factures</div></div></div>
    <div class="outils"><input class="search" id="q" placeholder="Rechercher un client, un email, une facture…" value="${esc(Q)}">
    <span class="tri" id="tri"></span></div>
    <table><thead><tr><th>Retard</th><th>Client</th><th class="num">Relances</th><th>Contact</th><th class="num">Montant dû</th></tr></thead><tbody id="corps"></tbody></table><div style="height:60px"></div>`;
  m.innerHTML = h;
  $('#q').addEventListener('input', (e) => { Q = e.target.value; tableau(); });
  tableau();
}

/** Lignes du tableau (recherche et tri sans redessiner la page). */
function tableau() {
  const R = ETAT?.R; if (!R || !$('#corps')) return;
  const tous = D.niveau5(R);
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
  const emails = [c.manager_email, ...c.contacts].filter(Boolean);
  const facs = c.factures.map((f) => `<li>${esc(f.ref)} · ${esc(f.site)} · échéance ${dfr(f.echeance)} · ${eur(f.reste)}</li>`).join('');
  return `<tr>
    <td data-l="Retard" class="c-retard"><span class="compteur ${classe}"><span class="v">${c.retard_max}</span> j</span>
      <div class="sub" style="margin-top:4px">niveau 5 depuis ${depuis} j${c.date_niveau5 ? ` (${dcourt(c.date_niveau5)})` : ''}</div></td>
    <td data-l="Client" class="c-client"><div class="client">${esc(c.client)}${c.particulier ? '<span class="tag">particulier</span>' : ''}</div>
      <details><summary>${c.factures.length} facture${c.factures.length > 1 ? 's' : ''} · ${esc(c.sites.join(' + '))}</summary><ul>${facs}</ul></details></td>
    <td data-l="Relances" class="num relances c-rel"><div class="v">${c.relances.length}</div><div class="sub">${derniere ? `dernière le ${dfr(derniere)}` : 'aucune'}</div></td>
    <td data-l="Contact" class="contact c-contact">${c.manager ? `<div>${esc(c.manager)}</div>` : ''}
      ${emails.map((e) => `<div><a href="mailto:${esc(e)}">${esc(e)}</a></div>`).join('') || '<span class="sub">aucun email dans Archie</span>'}</td>
    <td data-l="Montant dû" class="num c-montant"><div class="montant">${eur(c.total)}</div></td>
  </tr>`;
}

window.S = {
  actualiser: () => actualiser(),
  trier: (k) => { TRI = k; tableau(); },
};

(async function init() {
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !window.supabase) { $('#main').innerHTML = '<div class="center"><h2>Configuration en attente</h2></div>'; return; }
  sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
  $('#b-out').addEventListener('click', async () => { await sb.auth.signOut(); courant = null; vueConnexion(); });
  const { data } = await sb.auth.getSession();
  await afficher(data.session);
  sb.auth.onAuthStateChange((evt, session) => { if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') afficher(session); });
})();
