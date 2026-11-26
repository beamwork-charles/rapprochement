// Écran « Pointage » : connexion, dépôt du relevé, analyse (moteur dans le navigateur), validation vers Archie.
// Portage de src_reference/ui/index.html + server.py sur Supabase.
import { lireReleve } from './releve.js?v=20261126-13';
import * as E from './engine.js?v=20261126-13';
import * as RL from './relances.js?v=20261126-13';
import * as D from './relances-donnees.js?v=20261126-13';

const C = window.CONFIG || {};
const XLSX = window.XLSX;
const SPACES = ['16-cours-albert-1er', '25-rue-du-4-septembre', '28-cours-albert-1er', '42-rue-notre-dame-des-victoires'];
const LOT_ENVOI = 5; // lignes par appel à la fonction « pointer »

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (v) => (v == null ? '' : Number(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €');
const eur0 = (v) => Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' €';
const dfr = (s) => (s ? s.slice(8, 10) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : '');
const jsq = (s) => esc(JSON.stringify(String(s))); // chaîne sûre dans un attribut onclick
const estMembre = (e) => String(e || '').toLowerCase().endsWith('@' + C.DOMAINE);

let sb = null, USER = null, courant;
let S = null; // état de l'écran
let TAB = 'pret', SEL = new Set(), Q = '', HIDE = false, FILT = { verif: '', cote: '' }, OVR = {}, PICK = new Set();
const TABS = { pret: 'Prêt à pointer', verif: 'À vérifier', cote: 'Mis de côté', deja: 'Déjà pointé' };
const PB = { 'Facture à confirmer': 'confirmer', 'Montant insuffisant': 'partiel', 'Trop payé': 'trop', 'Doublon possible': 'doublon', 'Montant différent': 'different', 'Payeur inconnu': 'inconnu', 'Saisi dans Archie sans virement': 'archie', 'Avance à imputer': 'trop' };
const SECTIONS = ['Saisi dans Archie sans virement', 'Avance à imputer']; // filtres qui ne concernent pas les lignes du relevé

function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(e._t); e._t = setTimeout(() => e.classList.remove('show'), 3600); }
function vue(html) { $('#main').innerHTML = html; }
function boutons() {
  const co = Boolean(USER), pret = S && S.status === 'ready';
  $('#b-out').hidden = !co; $('#b-nom').hidden = !co; $('#b-deposer').hidden = !co; $('#b-excel').hidden = !co;
  $('#b-reload').hidden = !co || !S?.releve; $('#b-clore').hidden = !co || !S?.releve;
  const occupe = !S || S.status === 'loading' || S.sending;
  $('#b-deposer').disabled = occupe; $('#b-reload').disabled = occupe || !pret || S.archieEnCours; $('#b-clore').disabled = occupe || !pret || S.archieEnCours;
  $('#who').textContent = USER ? USER.email : '';
}
const journal = (action, champs = {}) => sb.from('journal').insert({ action, releve_id: S?.releve?.id ?? null, ...champs }).then(({ error }) => { if (error) console.warn('Journal :', error.message); });

async function erreurFonction(error) {
  try {
    const j = await error.context.json();
    return j.error || (j.message ? `${j.message}${j.code ? ' (' + j.code + ')' : ''}` : error.message);
  } catch { return error.message; }
}

/** Appel d'une fonction, avec deux nouvelles tentatives si l'instance manque de ressources (code 546) ou ne répond pas. */
async function appelFonction(nom, body) {
  for (let essai = 0; ; essai++) {
    const { data, error } = await sb.functions.invoke(nom, { body });
    if (!error) return data;
    const statut = error.context?.status;
    if (essai < 2 && (!statut || statut === 546 || statut >= 502)) { await new Promise((r) => setTimeout(r, 1500 * (essai + 1))); continue; }
    throw new Error(await erreurFonction(error));
  }
}

/** Lecture d'un bâtiment par lots (même contenu et même ordre que archie.Client.fetch). */
async function lireBatiment(space, sinceInv, sincePay, unLot) {
  const { compte_virement, compte_trop_percu } = await appelFonction('archie-donnees', { space, quoi: 'compte' });
  const inv = [], pay = [];
  let site = space;
  for (const [quoi, since, dest] of [['ouvertes', sinceInv, inv], ['payees', sinceInv, inv], ['paiements', sincePay, pay]]) {
    let curseur = null;
    do {
      const r = await appelFonction('archie-donnees', { space, quoi, since, curseur });
      dest.push(...r.items);
      if (r.items[0]) site = r.items[0].site;
      curseur = r.curseur;
      unLot();
    } while (curseur);
  }
  return { space, site, compte_virement, compte_trop_percu, inv, pay };
}

// ============================================================================ écarts et avances
const SEUIL_ECART = 5;
const societe = (space) => (space === '42-rue-notre-dame-des-victoires' ? '42' : 'the-bureau');
async function chargerAvances() {
  const { data, error } = await sb.from('avances').select('*').eq('statut', 'ouverte').order('cree_le');
  if (error) throw new Error(error.message);
  S.avances = data.map((a) => ({ ...a, restant: Math.round((Number(a.montant) - Number(a.montant_impute)) * 100) / 100 }));
}
/** Factures ouvertes du même client, imputables (même société), les plus anciennes d'abord. */
function facturesPour(a) {
  return (S.invoices || []).filter((i) => a.group_uuid && i.group_uuid === a.group_uuid && societe(i.space) === societe(a.space) && i.reste > 0.005)
    .sort((x, y) => (x.date || '').localeCompare(y.date || ''));
}
// ============================================================================ relances (lecture seule)
async function calculerRelances(factures) {
  const R = D.calculer(factures, await D.contexte(sb));
  S.relances = R;
  S.facturesOuvertes = factures;
  // mémorisé pour l'export Excel et la page de suivi (remplace le précédent)
  D.enregistrer(sb, R).catch((e) => console.warn('Relances non enregistrées :', e.message));
}
/** Relit seulement les factures ouvertes dans Archie (plus rapide qu'une analyse complète). */
async function actualiserRelances() {
  S.relancesEnCours = true; renderBody();
  try {
    await calculerRelances(await D.lireOuvertes(appelFonction));
    toast('Relances actualisées');
  } catch (e) { toast(`Actualisation impossible : ${e.message}`); }
  S.relancesEnCours = false; render();
}
const NIV = (n) => (n ? `Niveau ${n} · ${RL.LIBELLE_NIVEAU[n]}` : '—');

// ---- textes des relances (à valider avant tout envoi)
async function chargerModeles() {
  const { data, error } = await sb.from('modeles_relances').select('*').order('ordre');
  if (error) throw new Error(error.message);
  S.modeles = data;
}
function exempleClient(code) {
  const C = (S.relances?.clients || []).filter((c) => !c.exclu);
  if (code === 'niveau4_particulier') return C.find((c) => c.particulier) || C[0];
  const choisi = C.find((c) => c.cle === S.apercuClient);
  return choisi || C.find((c) => c.factures.length > 1) || C[0];
}
function apercu(m) {
  const c = exempleClient(m.code);
  if (!c) return '<span class="sub">Aucun client en retard pour l\'aperçu.</span>';
  const trame = (S.modeles.find((x) => x.code === 'ultime') || {}).corps || '';
  const v = RL.variablesRelance(c, S.relances.creneau, [], trame);
  const objet = $(`#mo-${m.code}`)?.value ?? m.objet, corps = $(`#mc-${m.code}`)?.value ?? m.corps;
  return `<div class="sub">Aperçu avec ${esc(c.client)} (envoi le ${dfr(S.relances.creneau)})</div>
    <div style="border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-top:6px;background:#fff">
      <div class="strong" style="margin-bottom:8px">${esc(RL.rendreModele(objet, v))}</div>
      <div style="white-space:pre-wrap;font-size:13px">${esc(RL.rendreModele(corps, v))}</div></div>`;
}
function textesView() {
  if (!S.modeles) return `<div class="empty">Chargement des textes…</div>`;
  const nbValides = S.modeles.filter((m) => m.statut === 'valide').length;
  const clients = (S.relances?.clients || []).filter((c) => !c.exclu);
  let h = `<div class="info"><b>Textes des relances : ${nbValides}/${S.modeles.length} validés.</b> Aucun envoi n'est possible tant que tous ne sont pas validés.
    Variables : ${RL.VARIABLES.map((v) => `<code>{${v}}</code>`).join(' ')}.
    <button class="btn sm" style="margin-left:8px" onclick="A.vueRelances('calendrier')">Retour au calendrier</button></div>
    <div class="tools"><label class="sub">Aperçu avec le client <select class="search" style="width:320px" onchange="A.apercuClient(this.value)">${clients.slice(0, 200).map((c) => `<option value="${esc(c.cle)}" ${exempleClient('').cle === c.cle ? 'selected' : ''}>${esc(c.client)} · ${c.factures.length} facture(s)${c.particulier ? ' · particulier' : ''}</option>`).join('')}</select></label></div>`;
  for (const m of S.modeles) {
    const statut = m.statut === 'valide'
      ? `<span class="badge" style="background:var(--green-l);color:var(--green)">Validé par ${esc(m.valide_par_email)} le ${new Date(m.valide_le).toLocaleDateString('fr-FR')}</span>`
      : '<span class="badge b-confirmer">Brouillon à valider</span>';
    h += `<div class="section">${esc(m.titre)} <small>version ${m.version} · ${m.destinataire === 'client' ? 'envoyé au client' : m.destinataire === 'interne' ? 'envoyé à Oscar et Charles' : 'envoyé à la main par les opérationnels'}</small></div>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:start">
        <div>${statut}
          <input id="mo-${m.code}" class="search" style="width:100%;margin:8px 0" value="${esc(m.objet)}" oninput="A.apercuMaj('${m.code}')">
          <textarea id="mc-${m.code}" rows="16" style="width:100%;border:1px solid var(--line);border-radius:8px;padding:8px;font-family:inherit;font-size:13px;line-height:1.45" oninput="A.apercuMaj('${m.code}')">${esc(m.corps)}</textarea>
          <div class="acts" style="justify-content:flex-start;flex-wrap:wrap;margin-top:6px"><button class="btn sm" onclick="A.enregistrerModele('${m.code}')">Enregistrer les modifications</button>
          <button class="btn sm primary" onclick="A.validerModele('${m.code}')" ${m.statut === 'valide' ? 'disabled' : ''}>Valider ce texte</button></div></div>
        <div id="ap-${m.code}">${apercu(m)}</div></div>`;
  }
  return h;
}
async function enregistrerModele(code) {
  const m = S.modeles.find((x) => x.code === code);
  const objet = $(`#mo-${code}`).value.trim(), corps = $(`#mc-${code}`).value.replace(/\s+$/, '');
  if (objet === m.objet && corps === m.corps) { toast('Aucune modification'); return; }
  const maj = { objet, corps, version: m.version + 1, statut: 'brouillon', modifie_par_email: USER.email, modifie_le: new Date().toISOString(), valide_par_email: null, valide_le: null };
  const { error } = await sb.from('modeles_relances').update(maj).eq('code', code);
  if (error) { toast(`Enregistrement impossible : ${error.message}`); return; }
  await sb.from('modeles_relances_historique').insert({ code, version: maj.version, objet, corps, statut: 'brouillon' });
  journal('texte de relance modifié', { resultat: `${m.titre} · version ${maj.version}` });
  await chargerModeles(); renderBody(); toast('Texte enregistré (à revalider)');
}
function validerModele(code) {
  const m = S.modeles.find((x) => x.code === code);
  if ($(`#mo-${code}`).value.trim() !== m.objet || $(`#mc-${code}`).value.replace(/\s+$/, '') !== m.corps) { toast('Enregistrez d\'abord vos modifications'); return; }
  confirmBox('Valider ce texte ?', `<p>${esc(m.titre)}, version ${m.version}.</p><p class="sub">Il pourra être utilisé pour les envois. Toute modification ultérieure le repassera en brouillon.</p>`, 'Valider', async () => {
    const { error } = await sb.from('modeles_relances').update({ statut: 'valide', valide_par_email: USER.email, valide_le: new Date().toISOString() }).eq('code', code);
    if (error) { toast(`Validation impossible : ${error.message}`); return; }
    await sb.from('modeles_relances_historique').insert({ code, version: m.version, objet: m.objet, corps: m.corps, statut: 'valide' });
    journal('texte de relance validé', { resultat: `${m.titre} · version ${m.version}` });
    await chargerModeles(); renderBody(); toast('Texte validé');
  });
}

function relancesView() {
  if (S.vueRelances === 'textes') return textesView();
  const R = S.relances;
  if (!R && S.archieEnCours) return `<div class="empty">Calendrier en cours de calcul : lecture d'Archie en arrière-plan…</div>`;
  if (!R) return `<div class="empty">Relances non calculées. <button class="btn sm" onclick="A.actualiserRelances()">Actualiser</button></div>`;
  const actifs = R.clients.filter((c) => !c.exclu);
  const tot = (L) => L.reduce((s, c) => s + c.total, 0);
  const parRetard = [1, 2, 3, 4, 5].map((n) => { const F = actifs.flatMap((c) => c.factures).filter((f) => f.niveau_retard === n); return [n, F.length, F.reduce((s, f) => s + f.reste, 0)]; });
  const prochains = actifs.filter((c) => c.prochaine_date === R.creneau);
  let h = `<div class="info"><b>${R.actives ? 'Relances activées' : 'Lecture seule : aucune relance n\'est envoyée.'}</b>
    Dernier relevé analysé le ${R.dernierReleve ? dfr(R.dernierReleve) : '—'}${R.suspendues ? ' — <b>plus de 2 jours ouvrés : les envois seraient suspendus</b>' : ''}.
    Calcul du ${R.calcule_le.toLocaleDateString('fr-FR')} à ${R.calcule_le.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.
    <button class="btn sm" style="margin-left:8px" onclick="A.actualiserRelances()" ${S.relancesEnCours ? 'disabled' : ''}>${S.relancesEnCours ? 'Lecture d\'Archie…' : 'Actualiser'}</button>
    <button class="btn sm" onclick="A.vueRelances('textes')">Textes des relances</button></div>
    <div class="modal" style="width:auto;max-width:none;box-shadow:none;border:1px solid var(--line);padding:16px 20px"><div class="kv" style="grid-template-columns:260px 1fr;margin:0">
      <span>Clients à relancer</span><b>${actifs.length} · ${actifs.reduce((s, c) => s + c.factures.length, 0)} factures · ${eur(tot(actifs))}</b>
      <span>Clients exclus (« ne pas relancer »)</span><b>${R.clients.length - actifs.length}</b>
      <span>Prochain envoi possible</span><b>${dfr(R.creneau)} à 8 h · ${prochains.length} client(s)</b>
      ${parRetard.map(([n, k, m]) => `<span>Selon le retard : ${NIV(n)}</span><b>${k} facture(s) · ${eur(m)}</b>`).join('')}
      <span>Hors périmètre (échues avant le ${dfr(RL.DEBUT_PERIMETRE)})</span><b>${R.hors.factures} facture(s) · ${eur(R.hors.total)}</b>
    </div></div>`;
  const q = Q.toLowerCase();
  const L = R.clients.filter((c) => !Q || (c.client + ' ' + c.factures.map((f) => f.ref).join(' ')).toLowerCase().includes(q));
  h += `<table><thead><tr><th>Client</th><th>Factures en retard</th><th class="num">Reste dû</th><th class="num">Retard max</th><th>Niveau atteint</th><th>Prochaine relance</th><th class="num">Action</th></tr></thead><tbody>`;
  if (!L.length) h += `<tr><td colspan="7" class="empty">Aucune facture en retard.</td></tr>`;
  for (const c of L) {
    const facs = c.factures.slice(0, 6).map((f) => `<div><span class="ref">${esc(f.ref)}</span> · ${esc(f.site)} · éch. ${dfr(f.echeance)} · ${eur(f.reste)}</div>`).join('') + (c.factures.length > 6 ? `<div class="sub">+ ${c.factures.length - 6} autre(s)</div>` : '');
    h += `<tr class="${c.exclu ? 'err' : ''}"><td><div class="strong">${esc(c.client)}</div>${c.particulier ? '<span class="badge b-part">Particulier : pas de frais de 40 €</span> ' : ''}${c.exclu ? `<span class="badge b-refus">Exclu${c.exclu.motif ? ' : ' + esc(c.exclu.motif) : ''}</span>` : ''}</td>
      <td class="facs">${facs}</td><td class="num strong">${eur(c.total)}</td><td class="num">${c.retard_max} j</td>
      <td>${c.niveau_atteint ? esc(NIV(c.niveau_atteint)) : '<span class="sub">aucune relance</span>'}</td>
      <td>${c.exclu ? '<span class="sub">aucune (exclu)</span>' : c.prochaine_date ? `<span class="badge b-niv">${esc(NIV(c.prochain_niveau))}</span><div class="sub">le ${dfr(c.prochaine_date)} à 8 h</div>` : '—'}</td>
      <td class="num">${!c.group_uuid ? '' : c.exclu ? `<button class="btn sm" onclick="A.reintegrer('${c.group_uuid}')">Réintégrer</button>` : `<button class="btn sm danger" onclick="A.exclureBox('${c.group_uuid}')">Exclure</button>`}</td></tr>`;
  }
  return h + `</tbody></table>`;
}
function exclureBox(g) {
  const c = S.relances.clients.find((x) => x.group_uuid === g);
  $('#modal').innerHTML = `<h3>Ne plus relancer ${esc(c.client)} ?</h3><p>Le client ne recevra aucune relance tant qu'il n'est pas réintégré.</p>
    <textarea id="motif" rows="2" placeholder="Motif : litige, accord de paiement…"></textarea>
    <div class="row"><button class="btn" onclick="A.fermer()">Annuler</button><button class="btn danger" id="mok">Exclure</button></div>`;
  $('#mok').onclick = async () => {
    const motif = $('#motif').value.trim(); closeM();
    const { error } = await sb.from('ne_pas_relancer').upsert({ group_uuid: g, client: c.client, motif, par: USER.id, par_email: USER.email, quand: new Date().toISOString() }, { onConflict: 'group_uuid' });
    if (error) { toast(`Exclusion impossible : ${error.message}`); return; }
    journal('exclusion relances', { resultat: `${c.client}${motif ? ' : ' + motif : ''}` });
    await calculerRelances(S.facturesOuvertes); render(); toast('Client exclu des relances');
  };
  $('#mbg').classList.add('show');
}
async function reintegrer(g) {
  const c = S.relances.clients.find((x) => x.group_uuid === g);
  const { error } = await sb.from('ne_pas_relancer').delete().eq('group_uuid', g);
  if (error) { toast(`Réintégration impossible : ${error.message}`); return; }
  journal('réintégration relances', { resultat: c?.client || g });
  await calculerRelances(S.facturesOuvertes); render(); toast('Client réintégré');
}

// ============================================================================ Excel (adresse protégée par jeton)
async function sha256hex(t) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function excelBox(nouvelleAdresse) {
  const { data: jetons } = await sb.from('jetons_export').select('id,libelle,cree_par_email,cree_le,revoque_le,dernier_usage').order('cree_le', { ascending: false });
  const actifs = (jetons || []).filter((j) => !j.revoque_le);
  $('#modal').innerHTML = `<h3>Classeur Excel « Suivi The Bureau »</h3>
    <p>Excel lit les données en lecture seule grâce à une adresse personnelle. Elle donne accès aux données : ne la partagez pas.</p>
    <p class="sub">1. Excel : Données › À partir du Web, collez l'adresse, OK (accès « Anonyme » si demandé).<br>
    2. Dans le Navigateur, cochez « Sélectionner plusieurs éléments », puis les tableaux voulus, et Charger.<br>
    3. Enregistrez le classeur. Ensuite, Données › Actualiser tout met tout à jour.</p>
    ${nouvelleAdresse ? `<p><b>Nouvelle adresse (affichée une seule fois) :</b></p><code class="url" id="url-excel">${esc(nouvelleAdresse)}</code>` : ''}
    ${actifs.length ? `<div class="kv" style="grid-template-columns:1fr auto">${actifs.map((j) => `<span>${esc(j.libelle || 'Adresse')} · ${esc(j.cree_par_email)} · ${new Date(j.cree_le).toLocaleDateString('fr-FR')}${j.dernier_usage ? ' · utilisée le ' + new Date(j.dernier_usage).toLocaleDateString('fr-FR') : ''}</span><button class="link" onclick="A.revoquer('${j.id}')">Révoquer</button>`).join('')}</div>` : ''}
    <div class="row"><button class="btn" onclick="A.fermer()">Fermer</button>${nouvelleAdresse ? '<button class="btn" id="copier">Copier l\'adresse</button>' : ''}<button class="btn primary" id="mok">Créer une adresse</button></div>`;
  $('#mok').onclick = async () => {
    const octets = crypto.getRandomValues(new Uint8Array(32));
    const jeton = btoa(String.fromCharCode(...octets)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const { error } = await sb.from('jetons_export').insert({ empreinte: await sha256hex(jeton), libelle: `Excel de ${$('#nom').value || USER.email}`, cree_par: USER.id });
    if (error) { toast(`Création impossible : ${error.message}`); return; }
    journal('adresse Excel créée', { resultat: `par ${USER.email}` });
    excelBox(`${C.SUPABASE_URL}/functions/v1/export?jeton=${jeton}`);
  };
  $('#copier')?.addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#url-excel').textContent); toast('Adresse copiée'); } catch { toast('Copie impossible : sélectionnez l\'adresse à la main'); } });
  $('#mbg').classList.add('show');
}
async function revoquer(id) {
  const { error } = await sb.from('jetons_export').update({ revoque_le: new Date().toISOString() }).eq('id', id);
  if (error) { toast(`Révocation impossible : ${error.message}`); return; }
  journal('adresse Excel révoquée', { resultat: id });
  toast('Adresse révoquée'); excelBox();
}

/** Explication de l'écart entre le virement et le montant pointé (affichée avant validation). */
function texteEcart(credit, tot) {
  const d = Math.round((credit - tot) * 100) / 100;
  if (d < -0.005) return `<div class="warn">Le montant pointé dépasse le virement de ${eur(-d)} : l'envoi sera refusé.</div>`;
  if (d >= SEUIL_ECART) return `<p class="sub">Trop-perçu de <b>${eur(d)}</b> : enregistré comme avance du client (note sur le paiement et sur sa fiche Archie), proposé sur sa prochaine facture. Un email d'information est préparé, il n'est pas envoyé.</p>`;
  if (d >= 0.01) return `<p class="sub">Écart de ${eur(d)} (moins de ${SEUIL_ECART} €) : aucun message au client, régularisation par la comptabilité.</p>`;
  return '';
}

/** Lit toutes les lignes d'une requête (l'API limite à 1000 lignes par appel). */
async function toutLire(fabrique) {
  const out = [];
  for (let de = 0; ; de += 1000) {
    const { data, error } = await fabrique().range(de, de + 999);
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

// ============================================================================ connexion
function vueConfig() { vue(`<div class="center"><h2>Configuration en attente</h2><p>L'outil n'est pas encore relié à sa base.</p></div>`); }

function vueConnexion(msg) {
  USER = null; S = null; boutons(); $('#dock').classList.remove('show');
  vue(`<div class="center"><h2>Connexion</h2><p>Saisissez votre adresse @${esc(C.DOMAINE)} : un lien de connexion vous sera envoyé.</p>
    <form class="form" id="f-login">
      <input id="email" type="email" autocomplete="email" placeholder="prenom@${esc(C.DOMAINE)}" required>
      <button class="btn primary" id="b-login">Recevoir le lien de connexion</button>
      <div class="err" id="err">${esc(msg || '')}</div>
    </form></div>`);
  $('#f-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#email').value.trim().toLowerCase();
    if (!estMembre(email)) { $('#err').textContent = `Adresse @${C.DOMAINE} uniquement.`; return; }
    $('#b-login').disabled = true; $('#err').textContent = '';
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) { $('#b-login').disabled = false; $('#err').textContent = error.message; return; }
    vue(`<div class="center"><h2>Lien envoyé</h2><p>Ouvrez l'email reçu à <b>${esc(email)}</b> et cliquez sur le lien pour vous connecter.</p>
      <p><button class="btn" onclick="A.connexion()">Utiliser une autre adresse</button></p></div>`);
  });
}

async function afficher(session) {
  const user = session && session.user;
  if ((user ? user.id : null) === courant) return;
  courant = user ? user.id : null;
  if (!user) return vueConnexion();
  if (!estMembre(user.email)) { await sb.auth.signOut(); return vueConnexion(`Adresse @${C.DOMAINE} uniquement.`); }
  // accès « suivi seul » (Oscar) : uniquement la page Suivi niveau 5 — la base et les fonctions le refusent de toute façon
  const { data: acces } = await sb.rpc('mon_acces');
  if (acces === 'suivi') { location.replace('suivi.html'); return; }
  USER = user;
  await sb.from('profils').upsert({ id: user.id, email: user.email }, { onConflict: 'id', ignoreDuplicates: true });
  const { data } = await sb.from('profils').select('nom').eq('id', user.id).maybeSingle();
  const defaut = user.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  $('#nom').value = data?.nom || defaut;
  if (!data?.nom) sb.from('profils').update({ nom: defaut }).eq('id', user.id).then(() => {});
  await chargerReleve();
}

// ============================================================================ relevé et analyse
async function chargerReleve() {
  S = { status: 'loading', progress: 'Chargement du relevé…', lines: [], orphelins: [], invoices: [], actions: {}, avertissements: [], sending: false, releve: null };
  render();
  try {
    const { data: rel, error } = await sb.from('releves').select('*').neq('statut', 'clos').order('depose_le', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    if (!rel.length) { S.status = 'empty'; return render(); }
    S.releve = rel[0];
    const ops = await toutLire(() => sb.from('operations').select('*').eq('releve_id', S.releve.id).order('ordre'));
    S.bank = ops.map((o) => ({
      id: o.op_id, banque: o.banque, ligne: o.ligne, date: o.date_valeur, libelle: o.libelle || '', info: o.info || '',
      texte: ((o.libelle || '') + ' ' + (o.info || '')).trim(), credit: Number(o.credit), debit: Number(o.debit),
    }));
    // Analyse déjà enregistrée : affichage immédiat, puis relecture d'Archie en arrière-plan.
    if (S.releve.analyse_le && ops.length && ops.every((o) => o.categorie)) {
      await afficherAnalyseEnregistree(ops);
      analyser({ arrierePlan: true });
    } else await analyser();
  } catch (e) {
    S.status = 'error'; S.message = e.message; render();
  }
}

/** Reconstruit l'écran à partir du dernier classement enregistré (sans lire Archie). */
async function afficherAnalyseEnregistree(ops) {
  const rid = S.releve.id;
  const [decs, orph, pts] = await Promise.all([
    toutLire(() => sb.from('decisions').select('op_id,refus,motif,annulation_demandee').order('op_id')),
    toutLire(() => sb.from('orphelins').select('*').eq('releve_id', rid).order('orphelin_id')),
    toutLire(() => sb.from('pointages').select('id,op_id,facture_ref,montant').eq('releve_id', rid).eq('resultat', 'ok').order('id')),
  ]);
  const decisions = Object.fromEntries(decs.map((d) => [d.op_id, d]));
  S.lines = ops.map((o) => {
    const l = {
      id: o.op_id, banque: o.banque, ligne: o.ligne, date: o.date_valeur, libelle: o.libelle || '', info: o.info || '',
      texte: ((o.libelle || '') + ' ' + (o.info || '')).trim(), credit: Number(o.credit), debit: Number(o.debit),
      tab: o.categorie, props: o.propositions || [], detail: o.detail || '',
    };
    if (o.regle) l.regle = o.regle;
    if (o.probleme) l.probleme = o.probleme;
    if (o.ecart != null) l.ecart = Number(o.ecart);
    if (o.motif) l.motif = o.motif;
    if (o.origine) l.origine = o.origine;
    // les refus et remises à traiter décidés depuis l'enregistrement priment
    const d = decisions[l.id], avant = l.probleme ? 'verif' : 'pret';
    if (l.tab === 'cote' && (l.motif || '').startsWith('Refusé')) {
      if (d?.refus) { l.refuse = true; l.tab_origine = avant; } else { l.tab = avant; delete l.motif; }
    } else if (d?.refus && (l.tab === 'pret' || l.tab === 'verif')) {
      l.tab_origine = l.tab; l.tab = 'cote'; l.refuse = true; l.motif = 'Refusé' + (d.motif ? ` : ${d.motif}` : '');
    }
    if (d?.annulation_demandee && l.tab === 'deja') l.annulation = true;
    return l;
  });
  S.orphelins = orph.map((o) => ({
    id: o.orphelin_id, date: o.date_paiement, montant: Number(o.montant), facture: o.facture, client: o.client, site: o.site,
    saisi: o.saisi_le, detail: o.detail, vu: Boolean(decisions[o.orphelin_id]?.refus),
  })).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  // lignes pointées par l'outil depuis : affichées « Pointé » comme dans la session d'origine
  S.actions = {};
  for (const p of pts) {
    const a = (S.actions[p.op_id] ||= { resultat: 'ok', paiements: [] });
    a.paiements.push({ ref: p.facture_ref, montant: Number(p.montant) });
  }
  try { await chargerAvances(); } catch (e) { S.avances = []; }
  S.avertissements = [...(S.releve.avertissements || [])];
  S.invoices = []; S.relances = null;
  S.analyse_le = new Date(S.releve.analyse_le);
  S.enregistree = true;
  S.status = 'ready';
  render(); remplirFactures();
}

/** Indicateur de relecture d'Archie (sans redessiner l'écran). */
function majEtatArchie() {
  const e = $('#etat-archie');
  if (e) e.textContent = S.progress || '';
}

async function analyser({ arrierePlan = false } = {}) {
  const etat = S; // un rechargement ou un dépôt remplace S : le résultat de cette lecture est alors abandonné
  const perime = () => S !== etat;
  if (arrierePlan) {
    S.archieEnCours = true; S.archieErreur = null; S.progress = "Lecture d'Archie…"; render();
  } else {
    S.status = 'loading'; S.progress = "Lecture d'Archie…"; S.actions = {}; SEL = new Set(); OVR = {}; PICK = new Set();
    render();
  }
  const echec = (message) => {
    if (perime()) return;
    if (arrierePlan) { S.archieEnCours = false; S.archieErreur = message; render(); }
    else { S.status = 'error'; S.message = message; render(); }
  };
  const credits = S.bank.filter((l) => l.credit > 0);
  if (!credits.length) return echec('Aucun encaissement dans ce relevé.');
  const dmin = credits.map((l) => l.date).sort()[0];
  const recul = (n) => new Date(Date.parse(dmin + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
  let nLots = 0, finis = 0;
  const maj = () => {
    if (perime()) return;
    S.progress = `Lecture d'Archie : ${finis}/${SPACES.length} bâtiments, ${nLots} lots lus…`;
    if (S.status === 'loading') render(); else majEtatArchie();
  };
  const lots = await Promise.all(SPACES.map(async (space) => {
    const r = await lireBatiment(space, recul(120), recul(20), () => { nLots++; maj(); });
    finis++; maj();
    return r;
  })).catch((e) => { echec(e.message); return null; });
  if (!lots || perime()) return;

  S.progress = 'Rapprochement…';
  if (arrierePlan) majEtatArchie(); else render();
  await new Promise((r) => setTimeout(r, 30));
  if (perime()) return;
  const inv = lots.flatMap((l) => l.inv), pay = lots.flatMap((l) => l.pay);
  const avert = [...(S.releve.avertissements || [])];
  for (const l of lots) if (!l.compte_virement) avert.push(`${l.site} : compte « Virement bancaire » introuvable dans Archie, les pointages y échoueront.`);
  for (const l of lots) if (!l.compte_trop_percu) avert.push(`${l.site} : compte « Trop-Perçu » introuvable dans Archie, les avances ne pourront pas y être imputées.`);
  let R, decisions;
  try {
    try { await chargerAvances(); } catch (e) { S.avances = []; avert.push(`Avances non chargées : ${e.message}`); }
    if (perime()) return;
    try { await calculerRelances(inv.filter((i) => ['open', 'partially_paid', 'processing_payment'].includes(i.state))); } catch (e) { avert.push(`Relances non calculées : ${e.message}`); }
    if (perime()) return;
    const decs = await toutLire(() => sb.from('decisions').select('op_id,refus,motif,annulation_demandee').order('op_id'));
    if (perime()) return;
    decisions = Object.fromEntries(decs.map((d) => [d.op_id, d]));
    const t0 = performance.now();
    R = E.run(S.bank, inv, pay, decisions);
    console.info(`Moteur : ${Math.round(performance.now() - t0)} ms, ${inv.length} factures, ${pay.length} paiements`);
  } catch (e) { return echec(e.message); }

  // annulations demandées : effectives si la ligne n'est plus « déjà pointée »
  for (const l of R.lines) {
    const d = decisions[l.id];
    if (d?.annulation_demandee) {
      if (l.tab !== 'deja') sb.from('decisions').update({ annulation_demandee: false }).eq('op_id', l.id).then(() => {});
      else l.annulation = true;
    }
  }
  S.lines = R.lines; S.orphelins = R.orphelins; S.avertissements = avert;
  S.invoices = R.invoices.filter((i) => i.reste > 0.005 && ['open', 'partially_paid'].includes(i.state))
    .map((i) => ({ uuid: i.uuid, space: i.space, ref: i.ref, client: i.client, site: i.site, reste: i.reste, date: i.date, group_uuid: i.group_uuid }))
    .sort((a, b) => (a.ref || '').localeCompare(b.ref || ''));
  if (arrierePlan) {
    // les pointages faits pendant la relecture restent affichés ; la sélection ne garde que les lignes encore à pointer
    const pret = new Set(inTab('pret').filter((l) => !isOk(l)).map((l) => l.id));
    const verif = new Set(inTab('verif').map((l) => l.id));
    SEL = new Set([...SEL].filter((id) => pret.has(id)));
    for (const id of Object.keys(OVR)) if (!verif.has(id)) delete OVR[id];
    PICK = new Set([...PICK].filter((id) => verif.has(id)));
    S.archieEnCours = false; S.archieErreur = null;
  }
  S.analyse_le = new Date();
  S.enregistree = false;
  S.status = 'ready';
  render(); remplirFactures();
  enregistrerAnalyse().catch((e) => { if (!perime()) { S.avertissements.push(`Analyse non enregistrée : ${e.message}`); render(); } });
  journal('analyse', { resultat: `${R.lines.length} encaissements analysés${arrierePlan ? ' (relecture en arrière-plan)' : ''}` });
}

/** Mémorise le classement (rapport, Excel) : opérations + paiements Archie sans virement. */
async function enregistrerAnalyse() {
  const rid = S.releve.id;
  const ordre = new Map(S.bank.map((l, k) => [l.id, k]));
  const rows = S.lines.map((l) => ({
    releve_id: rid, op_id: l.id, banque: l.banque, ligne: l.ligne, ordre: ordre.get(l.id), date_valeur: l.date,
    libelle: l.libelle, info: l.info, credit: l.credit, debit: l.debit,
    categorie: l.tab, regle: l.regle || null, probleme: l.probleme || null, ecart: l.ecart ?? null, detail: l.detail || null,
    motif: l.motif || null, origine: l.origine || null, propositions: l.props || [],
  }));
  for (let k = 0; k < rows.length; k += 500) {
    const { error } = await sb.from('operations').upsert(rows.slice(k, k + 500), { onConflict: 'releve_id,op_id' });
    if (error) throw new Error(error.message);
  }
  let r = await sb.from('orphelins').delete().eq('releve_id', rid);
  if (r.error) throw new Error(r.error.message);
  if (S.orphelins.length) {
    r = await sb.from('orphelins').insert(S.orphelins.map((o) => ({
      releve_id: rid, orphelin_id: o.id, date_paiement: o.date, montant: o.montant, facture: o.facture, client: o.client, site: o.site, saisi_le: o.saisi || null, detail: o.detail,
    })));
    if (r.error) throw new Error(r.error.message);
  }
  r = await sb.from('releves').update({ statut: 'ouvert', analyse_le: new Date().toISOString() }).eq('id', rid);
  if (r.error) throw new Error(r.error.message);
}

// ============================================================================ dépôt d'un relevé
async function deposer(fichier) {
  if (!fichier) return;
  try {
    const { lignes, avertissements } = await lireReleve(XLSX, await fichier.arrayBuffer());
    const credits = lignes.filter((l) => l.credit > 0);
    if (!credits.length) { toast(`Aucun encaissement trouvé dans « ${fichier.name} ». Vérifiez qu'il s'agit bien de l'export bancaire habituel.`); return; }
    const dates = credits.map((l) => l.date).sort();
    const total = credits.reduce((a, l) => a + l.credit, 0);
    const comptes = [...new Set(lignes.map((l) => l.banque))];
    // comparaison avec le relevé en cours : mêmes opérations = mêmes identifiants (refus, « vu » et pointages conservés)
    const enCours = S?.releve ? S : null;
    const connus = new Set((enCours?.bank || []).map((l) => l.id));
    const dejaConnues = credits.filter((l) => connus.has(l.id)).length, nouvelles = credits.length - dejaConnues;
    const fin = dates[dates.length - 1];
    let alerte = '';
    if (enCours && dejaConnues === credits.length && credits.length === connus.size) {
      alerte = `<div class="warn">Ce fichier contient exactement les mêmes encaissements que le relevé en cours (« ${esc(enCours.releve.fichier)} »). Le déposer ne change rien : pour relire Archie, utilisez plutôt « Recharger ».</div>`;
    } else if (enCours?.releve.date_max && fin < enCours.releve.date_max) {
      alerte = `<div class="warn">Ce fichier s'arrête le <b>${dfr(fin)}</b>, avant le relevé en cours (« ${esc(enCours.releve.fichier)} », jusqu'au ${dfr(enCours.releve.date_max)}). Il deviendrait pourtant le relevé à traiter : les encaissements reçus après le ${dfr(fin)} n'apparaîtraient plus tant qu'un relevé plus récent n'est pas déposé.</div>`;
    }
    confirmBox('Déposer ce relevé ?',
      `<div class="kv"><span>Fichier</span><b>${esc(fichier.name)}</b><span>Comptes</span><b>${esc(comptes.join(', '))}</b><span>Encaissements</span><b>${credits.length}</b><span>Total</span><b>${eur(total)}</b><span>Période</span><b>du ${dfr(dates[0])} au ${dfr(fin)}</b>
       ${enCours ? `<span>Déjà dans le relevé en cours</span><b>${dejaConnues} (reconnues : refus, « vu » et pointages conservés)</b><span>Nouvelles</span><b>${nouvelles}</b>` : ''}</div>
       ${alerte}
       ${avertissements.map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
       <p class="sub">Le relevé déposé devient le relevé à traiter. Rien n'est envoyé à Archie à cette étape.</p>`,
      'Déposer', async () => {
        S = { status: 'loading', progress: 'Enregistrement du relevé…', lines: [], orphelins: [], invoices: [], actions: {}, avertissements: [], sending: false, releve: null };
        render();
        try {
          const { data: rel, error } = await sb.from('releves').insert({
            fichier: fichier.name, date_min: dates[0], date_max: dates[dates.length - 1], nb_encaissements: credits.length,
            total_encaissements: Math.round(total * 100) / 100, avertissements, depose_par: USER.id,
          }).select().single();
          if (error) throw new Error(error.message);
          const ordre = new Map(lignes.map((l, k) => [l.id, k]));
          const rows = credits.map((l) => ({
            releve_id: rel.id, op_id: l.id, banque: l.banque, ligne: l.ligne, ordre: ordre.get(l.id), date_valeur: l.date,
            libelle: l.libelle, info: l.info, credit: l.credit, debit: l.debit,
          }));
          for (let k = 0; k < rows.length; k += 500) {
            const r = await sb.from('operations').insert(rows.slice(k, k + 500));
            if (r.error) throw new Error(r.error.message);
          }
          await sb.from('journal').insert({ action: 'dépôt', releve_id: rel.id, resultat: `${fichier.name} · ${credits.length} encaissements · ${eur(total)}` });
          await chargerReleve();
        } catch (e) { S.status = 'error'; S.message = `Dépôt impossible : ${e.message}`; render(); }
      });
  } catch (e) {
    toast(`Lecture impossible : ${e.message}`);
  } finally { $('#fichier').value = ''; }
}

// ============================================================================ helpers d'affichage
const act = (l) => (S.actions || {})[l.id];
const isOk = (l) => act(l) && act(l).resultat === 'ok';
const isBusy = (l) => act(l) && act(l).resultat === 'envoi';
const isErr = (l) => act(l) && act(l).resultat === 'erreur';
const inTab = (t) => S.lines.filter((l) => l.tab === t);
function match(l) {
  if (!Q) return true;
  const q = Q.toLowerCase();
  return (l.texte + ' ' + (l.props || []).map((p) => p.ref + ' ' + p.client).join(' ') + ' ' + (l.detail || '') + ' ' + l.credit).toLowerCase().includes(q);
}

// ============================================================================ rendu
function render() {
  boutons();
  const m = $('#main');
  if (!S) return;
  if (S.status === 'loading') { m.innerHTML = `<div class="center"><div class="big-spin"></div><h2>Analyse en cours</h2><p>${esc(S.progress || '')}</p><p class="sub">La lecture d'Archie prend environ une minute.</p></div>`; $('#dock').classList.remove('show'); return; }
  if (S.status === 'empty') { m.innerHTML = `<div class="center"><h2>Aucun relevé à traiter</h2><p>Déposez le relevé bancaire Excel le plus récent.</p><p style="margin-top:22px"><button class="btn primary" onclick="A.choisirFichier()">Déposer un relevé</button></p></div>`; $('#dock').classList.remove('show'); return; }
  if (S.status === 'error') { m.innerHTML = `<div class="center"><h2>L'analyse n'a pas abouti</h2><p>${esc(S.message)}</p><p style="margin-top:22px"><button class="btn primary" onclick="A.recharger()">Réessayer</button></p></div>`; $('#dock').classList.remove('show'); return; }

  const tot = S.lines.reduce((a, l) => a + l.credit, 0);
  const sums = {};
  Object.keys(TABS).forEach((t) => { const L = inTab(t); sums[t] = { n: L.length, a: L.reduce((x, l) => x + l.credit, 0) }; });
  const pretTodo = inTab('pret').filter((l) => !isOk(l)), pretDone = inTab('pret').filter(isOk);
  const verifTodo = inTab('verif').filter((l) => !isOk(l));
  const orphTodo = S.orphelins.filter((o) => !o.vu);
  const totTabs = Object.values(sums).reduce((x, s) => x + s.a, 0);
  const okCtl = Math.abs(tot - totTabs) < 0.01;
  const quand = `${S.analyse_le.toLocaleDateString('fr-FR')} à ${S.analyse_le.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
  const etatArchie = S.archieEnCours
    ? `<span class="maj"><span class="spin"></span> Mise à jour depuis Archie — <span id="etat-archie">${esc(S.progress || '')}</span></span>`
    : S.archieErreur ? `<span class="maj ko">Archie non relu : ${esc(S.archieErreur)} <button class="link" onclick="A.relire()">Réessayer</button></span>` : '';
  let h = `<div class="file"><b>${esc(S.releve.fichier)}</b><span>déposé le ${dfr(S.releve.depose_le.slice(0, 10))}</span><span>· ${S.enregistree ? 'dernière analyse enregistrée le' : 'analysé le'} ${quand}</span>${etatArchie}</div>`;
  (S.avertissements || []).forEach((w) => (h += `<div class="warn">${esc(w)}</div>`));
  h += `<div class="tiles">
    ${tile('pret', 'Prêt à pointer', pretTodo.length, pretTodo.reduce((x, l) => x + l.credit, 0), pretDone.length ? `${pretDone.length} pointée(s) dans cette session` : 'Facture identifiée, montant exact')}
    ${tile('verif', 'À vérifier', verifTodo.length + orphTodo.length + (S.avances || []).length, verifTodo.reduce((x, l) => x + l.credit, 0), 'Une décision est nécessaire')}
    ${tile('cote', 'Mis de côté', sums.cote.n, sums.cote.a, 'Carte, titres-resto, interne, refusés')}
    ${tile('deja', 'Déjà pointé', sums.deja.n, sums.deja.a, 'Pointé avant cette passe')}
    ${tile('relances', 'Relances', S.relances ? S.relances.clients.filter((c) => !c.exclu).length : '—', S.relances ? S.relances.clients.filter((c) => !c.exclu).reduce((s, c) => s + c.total, 0) : 0, 'Clients en retard (lecture seule)')}
  </div>
  <div class="ctl ${okCtl ? 'ok' : 'ko'}">Contrôle : ${S.lines.length} encaissements · ${eur(tot)} · <b>${okCtl ? 'tous répartis dans les 4 onglets ✓' : 'écart ' + eur(tot - totTabs)}</b></div>`;
  h += `<div class="tools"><input class="search" id="q" placeholder="Rechercher un client, une facture, un montant…" value="${esc(Q)}">
        <span id="chips"></span>
        ${TAB === 'pret' || TAB === 'verif' ? `<label class="toggle"><input type="checkbox" id="hide" ${HIDE ? 'checked' : ''}> Masquer les lignes pointées</label>` : ''}</div>
        <div id="body" class="tablewrap"></div><div class="pad-bottom"></div>`;
  m.innerHTML = h;
  $('#q').addEventListener('input', (e) => { Q = e.target.value; renderBody(); });
  $('#hide')?.addEventListener('change', (e) => { HIDE = e.target.checked; renderBody(); });
  renderBody();
}
function tile(k, t, n, a, s) {
  return `<button class="tile ${k} ${TAB === k ? 'on' : ''}" onclick="A.onglet('${k}')"><div class="t">${t}</div><div class="n">${n}</div><div class="a">${eur0(a)}</div><div class="s">${s}</div><div class="bar"></div></button>`;
}
function renderBody() {
  const b = $('#body'); if (!b) return;
  if (TAB === 'pret') b.innerHTML = pretView();
  if (TAB === 'verif') b.innerHTML = verifView();
  if (TAB === 'cote') b.innerHTML = coteView();
  if (TAB === 'deja') b.innerHTML = dejaView();
  if (TAB === 'relances') b.innerHTML = relancesView();
  chips(); dock();
}
function statusCell(l, selectable) {
  if (isOk(l)) return `<span class="done"><i></i>Pointé</span>`;
  if (isBusy(l)) return `<span class="spin"></span>`;
  if (isErr(l)) return `<span class="fail" title="${esc(act(l).message)}"><i>!</i>Échec</span>` + (selectable ? `<div style="margin-top:6px"><input type="checkbox" class="cb" ${SEL.has(l.id) ? 'checked' : ''} onchange="A.tog('${l.id}',this.checked)" title="Réessayer"></div>` : '');
  return selectable ? `<input type="checkbox" class="cb" ${SEL.has(l.id) ? 'checked' : ''} onchange="A.tog('${l.id}',this.checked)">` : '';
}
const propsCell = (l) => (l.props || []).map((p) => `<div><span class="ref">${esc(p.ref)}</span> <span class="sub">${esc(p.site)}</span></div>`).join('');

/* ---- Prêt à pointer */
function pretView() {
  const L = inTab('pret').filter(match).filter((l) => !(HIDE && isOk(l)));
  L.sort((a, b) => a.date.localeCompare(b.date) || a.banque.localeCompare(b.banque));
  if (!L.length) return `<div class="empty">Aucune ligne.</div>`;
  const sel = L.filter((l) => !isOk(l) && !isBusy(l));
  const all = sel.length && sel.every((l) => SEL.has(l.id));
  let h = `<table><thead><tr><th>Date</th><th>Client</th><th>Facture</th><th class="num">Montant</th><th>Virement</th>
    <th class="ck"><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">Tout <input type="checkbox" class="cb" ${all ? 'checked' : ''} onchange="A.togAll(this.checked)" ${S.sending ? 'disabled' : ''}></label></th></tr></thead><tbody>`;
  for (const l of L) {
    const cli = [...new Set((l.props || []).map((p) => p.client))].join(', ');
    h += `<tr class="${isOk(l) ? 'ok' : isErr(l) ? 'err' : ''}"><td class="date">${dfr(l.date)}</td>
      <td><div class="strong">${esc(cli)}</div><div class="sub">${esc(l.regle)}</div></td>
      <td class="prop">${propsCell(l)}</td>
      <td class="num strong">${eur(l.credit)}</td>
      <td><div class="lib" title="${esc(l.texte)}">${esc(l.texte)}</div><div class="sub">${esc(l.banque)}</div>${isErr(l) ? `<div class="errmsg">${esc(act(l).message)}</div>` : ''}</td>
      <td class="ck">${statusCell(l, !S.sending)}</td></tr>`;
  }
  return h + `</tbody></table>`;
}
function dock() {
  const d = $('#dock');
  const L = S.lines.filter((l) => SEL.has(l.id) && !isOk(l));
  if (TAB !== 'pret' || !L.length || S.sending) { d.classList.remove('show'); return; }
  $('#dock-sum').innerHTML = `<b>${L.length}</b> ligne(s) sélectionnée(s) · <b>${eur(L.reduce((x, l) => x + l.credit, 0))}</b>`;
  d.classList.add('show');
}
function validerSel() {
  const L = S.lines.filter((l) => SEL.has(l.id) && !isOk(l));
  if (!L.length) return;
  const nbp = L.reduce((x, l) => x + l.props.length, 0);
  confirmBox('Enregistrer dans Archie ?',
    `<div class="kv"><span>Virements</span><b>${L.length}</b><span>Paiements à créer</span><b>${nbp}</b><span>Montant total</span><b>${eur(L.reduce((x, l) => x + l.credit, 0))}</b><span>Date du paiement</span><b>date de valeur bancaire</b><span>Mode</span><b>Virement bancaire</b><span>Email au client</span><b>Non</b><span>Validé par</span><b>${esc($('#nom').value)}</b></div>
     <p class="sub">Une fois enregistré, un paiement ne peut être annulé que dans Archie.</p>`,
    'Enregistrer', () => envoyer(L.map((l) => ({ id: l.id, props: l.props.map((p) => ({ uuid: p.uuid, space: p.space, montant: p.montant })) }))));
}
async function envoyer(items) {
  items.forEach((i) => { S.actions[i.id] = { resultat: 'envoi' }; SEL.delete(i.id); });
  S.sending = true; renderBody(); boutons();
  for (let k = 0; k < items.length; k += LOT_ENVOI) {
    const lot = items.slice(k, k + LOT_ENVOI);
    const { data, error } = await sb.functions.invoke('pointer', { body: { releve_id: S.releve.id, items: lot.map((i) => ({ op_id: i.id, props: i.props })) } });
    if (error) {
      const msg = await erreurFonction(error);
      lot.forEach((i) => (S.actions[i.id] = { resultat: 'erreur', message: msg }));
    } else {
      for (const r of data.resultats) S.actions[r.op_id] = r;
    }
    renderBody();
  }
  S.sending = false;
  const avances = items.filter((i) => S.actions[i.id]?.avance).length;
  if (avances) { try { await chargerAvances(); } catch { /* affichée au prochain chargement */ } }
  render(); boutons();
  const ko = items.filter((i) => S.actions[i.id]?.resultat !== 'ok').length;
  toast((ko ? `Envoi terminé : ${ko} ligne(s) en échec` : 'Envoi terminé') + (avances ? ` · ${avances} avance(s) client enregistrée(s)` : ''));
}

/* ---- À vérifier */
function verifView() {
  let L = inTab('verif').filter(match).filter((l) => !(HIDE && isOk(l)));
  if (FILT.verif) L = L.filter((l) => l.probleme === FILT.verif);
  const order = Object.keys(PB);
  L.sort((a, b) => order.indexOf(a.probleme) - order.indexOf(b.probleme) || a.date.localeCompare(b.date));
  let h = '';
  const petitEcart = (l) => {
    if (!(Math.abs(l.ecart || 0) > 0.005 && Math.abs(l.ecart) < SEUIL_ECART)) return '';
    if (l.probleme === 'Montant insuffisant') return ` · écart < ${SEUIL_ECART} € : pas de relance, régularisation comptable`;
    if (l.probleme === 'Trop payé') return ` · écart < ${SEUIL_ECART} € : pas d'avance ni de message au client`;
    return '';
  };
  if (!SECTIONS.includes(FILT.verif)) {
    h += `<table><thead><tr><th>Problème</th><th>Date</th><th class="num">Reçu</th><th>Virement et explication</th><th>Proposition</th><th class="num" style="width:180px">Décision</th></tr></thead><tbody>`;
    if (!L.length) h += `<tr><td colspan="6" class="empty">Aucune ligne.</td></tr>`;
    for (const l of L) {
      const k = PB[l.probleme] || 'inconnu';
      h += `<tr class="${isOk(l) ? 'ok' : isErr(l) ? 'err' : ''}"><td><span class="badge b-${k}">${esc(l.probleme)}</span></td>
        <td class="date">${dfr(l.date)}</td><td class="num strong">${eur(l.credit)}</td>
        <td><div class="lib" title="${esc(l.texte)}">${esc(l.texte)}</div><div class="expl">${esc(l.detail)}${esc(petitEcart(l))}</div><div class="sub">${esc(l.banque)}</div>${isErr(l) ? `<div class="errmsg">${esc(act(l).message)}</div>` : ''}${isOk(l) && act(l).avance ? `<div class="expl">Avance de ${eur(act(l).avance.montant)} enregistrée${act(l).avertissement ? ' — ' + esc(act(l).avertissement) : ''}</div>` : ''}</td>
        <td class="propcell">${proposition(l)}</td>
        <td class="num">${isOk(l) ? `<span class="done"><i></i>Pointé</span>` : isBusy(l) ? '<span class="spin"></span>' : `<div class="acts"><button class="btn sm danger" onclick="A.refuserBox(['${l.id}'],'cette ligne')" ${S.sending ? 'disabled' : ''}>Refuser</button><button class="btn sm primary" onclick="A.validerUne('${l.id}')" ${propsFor(l).length && !S.sending ? '' : 'disabled'}>Valider</button></div>`}</td></tr>`;
    }
    h += `</tbody></table>`;
  }
  if (!FILT.verif || FILT.verif === 'Saisi dans Archie sans virement') {
    const O = S.orphelins.filter((o) => !Q || (o.client + ' ' + o.facture + ' ' + o.montant).toLowerCase().includes(Q.toLowerCase()));
    h += `<div class="section">Saisis dans Archie sans virement<small>paiements présents dans Archie mais absents du relevé — à contrôler</small></div>
      <table><thead><tr><th>Problème</th><th>Date</th><th class="num">Montant</th><th>Facture</th><th>Observation</th><th class="num">Décision</th></tr></thead><tbody>`;
    if (!O.length) h += `<tr><td colspan="6" class="empty">Aucun.</td></tr>`;
    for (const o of O) {
      h += `<tr><td><span class="badge b-archie">Archie sans virement</span></td><td class="date">${dfr(o.date)}</td><td class="num strong">${eur(o.montant)}</td>
      <td><span class="ref">${esc(o.facture)}</span><div class="sub">${esc(o.client)} · ${esc(o.site)}</div></td><td><div class="expl">${esc(o.detail)}</div><div class="sub">saisi le ${dfr(o.saisi)}</div></td>
      <td class="num">${o.vu ? `<span class="sub">Vu</span> <button class="link" onclick="A.remettre('${o.id}')">annuler</button>` : `<button class="btn sm" onclick="A.vu('${o.id}')">Marquer comme vu</button>`}</td></tr>`;
    }
    h += `</tbody></table>`;
  }
  if (!FILT.verif || FILT.verif === 'Avance à imputer') h += avancesView();
  return h;
}

/* ---- Avances clients (trop-perçus) */
function avancesView() {
  const AV = (S.avances || []).filter((a) => !Q || (a.client + ' ' + a.factures_soldees + ' ' + a.restant).toLowerCase().includes(Q.toLowerCase()));
  let h = `<div class="section">Avances clients à imputer<small>trop-perçus enregistrés, à déduire d'une facture ouverte du même client</small></div>
    <table><thead><tr><th>Client</th><th>Virement</th><th class="num">Avance restante</th><th>Imputer sur</th><th class="num">Décision</th></tr></thead><tbody>`;
  if (!AV.length) h += `<tr><td colspan="5" class="empty">Aucune.</td></tr>`;
  for (const a of AV) {
    const F = facturesPour(a);
    const choix = F.length
      ? `<select id="imp-f-${a.id}" class="search" style="width:260px" onchange="A.impMontant('${a.id}')">${F.map((i) => `<option value="${i.uuid}">${esc(i.ref)} · ${esc(i.site)} · reste ${eur(i.reste)}</option>`).join('')}</select>
         <input id="imp-m-${a.id}" class="search" style="width:110px;text-align:right" value="${String(Math.min(a.restant, F[0].reste).toFixed(2)).replace('.', ',')}">`
      : `<span class="sub">${!a.group_uuid ? 'Client Archie non identifié : à imputer à la main' : S.archieEnCours ? 'Factures en cours de lecture dans Archie…' : 'Aucune facture ouverte pour ce client pour l\'instant'}</span>`;
    h += `<tr><td><div class="strong">${esc(a.client)}</div><div class="sub">${esc(a.factures_soldees || '')}</div></td>
      <td class="date">${dfr(a.date_virement)}<div class="sub">${esc(a.par_email || '')}</div></td>
      <td class="num strong">${eur(a.restant)}${a.montant_impute > 0 ? `<div class="sub">sur ${eur(a.montant)}</div>` : ''}</td>
      <td>${choix}</td>
      <td class="num"><div class="acts"><button class="btn sm" onclick="A.emailBox('${a.id}')">Email préparé</button><button class="btn sm primary" onclick="A.imputerBox('${a.id}')" ${F.length && !S.sending ? '' : 'disabled'}>Imputer</button></div></td></tr>`;
  }
  return h + `</tbody></table>`;
}
function impMontant(id) {
  const a = S.avances.find((x) => x.id === id);
  const i = S.invoices.find((x) => x.uuid === $(`#imp-f-${id}`).value);
  if (a && i) $(`#imp-m-${id}`).value = String(Math.min(a.restant, i.reste).toFixed(2)).replace('.', ',');
}
function imputerBox(id) {
  const a = S.avances.find((x) => x.id === id);
  const i = S.invoices.find((x) => x.uuid === $(`#imp-f-${id}`)?.value);
  const m = Math.round(parseFloat(String($(`#imp-m-${id}`)?.value || '').replace(/\s/g, '').replace(',', '.')) * 100) / 100;
  if (!a || !i) return;
  if (!(m > 0) || m > a.restant + 0.005 || m > i.reste + 0.005) { toast(`Montant invalide (au plus ${eur(Math.min(a.restant, i.reste))})`); return; }
  confirmBox('Imputer cette avance ?',
    `<div class="kv"><span>Client</span><b>${esc(a.client)}</b><span>Avance</span><b>${eur(a.restant)} (virement du ${dfr(a.date_virement)})</b><span>Facture</span><b>${esc(i.ref)} · ${esc(i.site)}</b><span>Montant imputé</span><b>${eur(m)}</b><span>Mode</span><b>Trop-Perçu</b><span>Date du paiement</span><b>aujourd'hui</b><span>Email au client</span><b>Non</b></div>
     <p class="sub">Une fois enregistré, un paiement ne peut être annulé que dans Archie.</p>`,
    'Imputer', async () => {
      S.sending = true; renderBody(); boutons();
      const { data, error } = await sb.functions.invoke('imputer', { body: { avance_id: a.id, facture_uuid: i.uuid, space: i.space, montant: m } });
      S.sending = false;
      if (error) { toast(await erreurFonction(error)); renderBody(); boutons(); return; }
      if (data.resultat !== 'ok') { toast(`Imputation refusée : ${data.message}`); renderBody(); boutons(); return; }
      i.reste = Math.round((i.reste - m) * 100) / 100;
      await chargerAvances();
      render(); remplirFactures();
      toast(`Avance imputée sur ${data.facture_ref} : ${eur(data.montant)}`);
    });
}
function emailBox(id) {
  const a = S.avances.find((x) => x.id === id);
  const e = a?.email_prepare || {};
  $('#modal').innerHTML = `<h3>Email d'information préparé</h3>
    <div class="kv"><span>Destinataires</span><b>${esc((e.destinataires || []).join(', ') || 'à compléter')}</b><span>Objet</span><b>${esc(e.objet || '')}</b></div>
    <textarea id="email-texte" rows="12">${esc(e.texte || '')}</textarea>
    <p class="sub">Brouillon à relire : il n'est pas envoyé par l'outil.</p>
    <div class="row"><button class="btn" onclick="A.fermer()">Fermer</button><button class="btn primary" id="mok">Copier le texte</button></div>`;
  $('#mok').onclick = async () => {
    try { await navigator.clipboard.writeText(`Objet : ${e.objet || ''}\n\n${$('#email-texte').value}`); toast('Texte copié'); } catch { toast('Copie impossible : sélectionnez le texte à la main'); }
  };
  $('#mbg').classList.add('show');
}
function propsFor(l) {
  const o = OVR[l.id];
  if (o) return o.uuid ? [o] : [];
  return (l.props || []).map((p) => ({ uuid: p.uuid, space: p.space, montant: p.montant, ref: p.ref, client: p.client }));
}
function proposition(l) {
  if (isOk(l)) return (act(l).paiements || []).map((p) => `<div class="prop"><span class="ref">${esc(p.ref)}</span> · ${eur(p.montant)}</div>`).join('');
  const o = OVR[l.id];
  if (!PICK.has(l.id) && (l.props || []).length) {
    return `<div class="prop">${l.props.map((p) => `<div><span class="ref">${esc(p.ref)}</span> · <span class="cli" title="${esc(p.client)}">${esc(p.client)}</span> · <b>${eur(p.montant)}</b>${p.reste_apres > 0.005 ? ` <span class="sub">(reste ${eur(p.reste_apres)})</span>` : ''}</div>`).join('')}</div>
      <button class="link" onclick="A.pick('${l.id}',true)">Choisir une autre facture</button>`;
  }
  const v = o && o.label ? o.label : '';
  const mt = o && o.montant != null ? o.montant : '';
  return `<div class="pick"><input class="f" list="invlist" placeholder="${S.archieEnCours ? 'Lecture d\'Archie en cours…' : 'N° de facture ou client…'}" value="${esc(v)}" onchange="A.choisir('${l.id}',this.value)">
    <input class="m" placeholder="Montant" value="${mt === '' ? '' : String(mt).replace('.', ',')}" onchange="A.montant('${l.id}',this.value)"></div>
    ${(l.props || []).length ? `<button class="link" onclick="A.pick('${l.id}',false)">Revenir à la proposition</button>` : ''}`;
}
const invLabel = (i) => `${i.ref} · ${i.client} · ${eur(i.reste)}`;
function choisir(id, val) {
  const ref = (val || '').split(' · ')[0].trim();
  const i = S.invoices.find((x) => x.ref === ref);
  const l = S.lines.find((x) => x.id === id);
  if (!i) { delete OVR[id]; toast('Facture introuvable parmi les factures ouvertes'); renderBody(); return; }
  OVR[id] = { uuid: i.uuid, space: i.space, ref: i.ref, client: i.client, label: invLabel(i), montant: Math.min(l.credit, i.reste) };
  renderBody();
}
function montant(id, val) {
  const o = OVR[id]; if (!o) return;
  const v = parseFloat(String(val).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isNaN(v) && v > 0) o.montant = Math.round(v * 100) / 100;
  renderBody();
}
function validerUne(id) {
  const l = S.lines.find((x) => x.id === id); const P = propsFor(l);
  if (!P.length) return;
  const tot = P.reduce((x, p) => x + p.montant, 0);
  confirmBox('Pointer ce virement ?',
    `<div class="kv"><span>Virement</span><b>${eur(l.credit)} du ${dfr(l.date)}</b>${P.map((p) => `<span>${esc(p.ref)}</span><b>${eur(p.montant)} · ${esc(p.client || '')}</b>`).join('')}<span>Total pointé</span><b>${eur(tot)}</b><span>Email au client</span><b>Non</b></div>
     ${texteEcart(l.credit, tot)}`,
    'Enregistrer', () => envoyer([{ id, props: P.map((p) => ({ uuid: p.uuid, space: p.space, montant: p.montant })) }]));
}

/* ---- Mis de côté */
function coteView() {
  let L = inTab('cote').filter(match);
  const mot = (l) => (l.refuse ? 'Refusé' : l.motif);
  if (FILT.cote) L = L.filter((l) => mot(l) === FILT.cote);
  L.sort((a, b) => (b.refuse ? 1 : 0) - (a.refuse ? 1 : 0) || a.date.localeCompare(b.date));
  if (!L.length) return `<div class="empty">Aucune ligne.</div>`;
  let h = `<table><thead><tr><th>Motif</th><th>Date</th><th class="num">Montant</th><th>Libellé</th><th>Banque</th><th class="num">Action</th></tr></thead><tbody>`;
  for (const l of L) {
    h += `<tr><td><span class="badge ${l.refuse ? 'b-refus' : 'b-cote'}">${esc(l.motif)}</span></td><td class="date">${dfr(l.date)}</td><td class="num strong">${eur(l.credit)}</td>
     <td><div class="lib" title="${esc(l.texte)}">${esc(l.texte)}</div></td><td class="sub">${esc(l.banque)}</td>
     <td class="num">${l.refuse ? `<button class="btn sm" onclick="A.remettre('${l.id}')">Remettre à traiter</button>` : ''}</td></tr>`;
  }
  return h + `</tbody></table>`;
}

/* ---- Déjà pointé */
function dejaView() {
  const L = inTab('deja').filter(match);
  L.sort((a, b) => a.date.localeCompare(b.date));
  if (!L.length) return `<div class="empty">Aucune ligne.</div>`;
  let h = `<table><thead><tr><th>Origine</th><th>Date</th><th class="num">Montant</th><th>Virement</th><th>Pointé sur</th><th class="num">Action</th></tr></thead><tbody>`;
  for (const l of L) {
    const outil = l.origine === "Pointé par l'outil";
    h += `<tr><td><span class="badge ${outil ? 'b-outil' : 'b-archiem'}">${esc(l.origine)}</span></td><td class="date">${dfr(l.date)}</td><td class="num strong">${eur(l.credit)}</td>
      <td><div class="lib" title="${esc(l.texte)}">${esc(l.texte)}</div><div class="sub">${esc(l.banque)}</div></td><td class="prop">${esc(l.detail)}</td>
      <td class="num">${l.annulation ? '<span class="badge b-refus">Annulation demandée</span>' : `<button class="btn sm" onclick="A.annulerBox('${l.id}')">Annuler ce pointage</button>`}</td></tr>`;
  }
  return h + `</tbody></table>`;
}

/* ---- filtres */
function chips() {
  const c = $('#chips'); if (!c) return;
  let opts = [], key = null;
  if (TAB === 'verif') {
    key = 'verif';
    const n = (p) => (p === 'Saisi dans Archie sans virement' ? S.orphelins.filter((o) => !o.vu).length
      : p === 'Avance à imputer' ? (S.avances || []).length : inTab('verif').filter((l) => l.probleme === p && !isOk(l)).length);
    opts = Object.keys(PB).map((p) => [p, n(p)]).filter((x) => x[1] > 0);
  }
  if (TAB === 'cote') { key = 'cote'; const m = {}; inTab('cote').forEach((l) => { const k = l.refuse ? 'Refusé' : l.motif; m[k] = (m[k] || 0) + 1; }); opts = Object.entries(m); }
  if (!key) { c.innerHTML = ''; return; }
  c.innerHTML = `<button class="chip ${!FILT[key] ? 'on' : ''}" onclick="A.filtre('${key}','')">Tout</button> ` +
    opts.map(([k, n]) => `<button class="chip ${FILT[key] === k ? 'on' : ''}" onclick="A.filtre('${key}',${jsq(k)})">${esc(k)} · ${n}</button>`).join(' ');
}

// ============================================================================ décisions (refus, vu, remise à traiter, annulation)
async function refuser(ids, motif) {
  const quand = new Date().toISOString();
  const rows = [];
  for (const id of ids) {
    if (id.startsWith('A')) { rows.push({ op_id: id, refus: true, motif: 'Vu', annulation_demandee: false, par: USER.id, par_email: USER.email, quand }); continue; }
    const l = S.lines.find((x) => x.id === id);
    if (!l || !['pret', 'verif'].includes(l.tab) || ['ok', 'envoi'].includes(act(l)?.resultat)) continue;
    rows.push({ op_id: id, refus: true, motif: motif || '', annulation_demandee: false, par: USER.id, par_email: USER.email, quand });
  }
  if (!rows.length) return;
  const { error } = await sb.from('decisions').upsert(rows, { onConflict: 'op_id' });
  if (error) { toast(`Refus non enregistré : ${error.message}`); return; }
  for (const r of rows) {
    if (r.op_id.startsWith('A')) {
      const o = S.orphelins.find((x) => x.id === r.op_id); if (o) o.vu = true;
      journal('vu', { op_id: r.op_id, facture: o?.facture, montant: o?.montant, resultat: 'Paiement Archie marqué comme vu' });
      continue;
    }
    const l = S.lines.find((x) => x.id === r.op_id);
    l.tab_origine = l.tab; l.tab = 'cote'; l.refuse = true; l.motif = 'Refusé' + (motif ? ` : ${motif}` : '');
    SEL.delete(l.id);
    journal('refus', { op_id: l.id, montant: l.credit, resultat: l.motif });
  }
  render();
}
async function remettre(id) {
  const { error } = await sb.from('decisions').delete().eq('op_id', id);
  if (error) { toast(`Action impossible : ${error.message}`); return; }
  if (id.startsWith('A')) { const o = S.orphelins.find((x) => x.id === id); if (o) o.vu = false; render(); return; }
  const l = S.lines.find((x) => x.id === id);
  if (l && l.refuse) {
    l.tab = l.tab_origine || 'verif'; delete l.tab_origine; delete l.refuse; delete l.motif;
    journal('remise à traiter', { op_id: id, montant: l.credit, resultat: 'Ligne remise à traiter' });
  }
  render(); toast('Ligne remise à traiter');
}
async function demanderAnnulation(id) {
  const l = S.lines.find((x) => x.id === id); if (!l) return;
  const { error } = await sb.from('decisions').upsert({ op_id: id, refus: false, annulation_demandee: true, par: USER.id, par_email: USER.email, quand: new Date().toISOString() }, { onConflict: 'op_id' });
  if (error) { toast(`Action impossible : ${error.message}`); return; }
  l.annulation = true;
  journal('annulation demandée', { op_id: id, montant: l.credit, resultat: "À annuler à la main dans Archie ; la ligne reviendra à l'analyse suivante" });
  render();
}

// ============================================================================ fenêtres
function confirmBox(title, html, okLabel, fn) {
  $('#modal').innerHTML = `<h3>${title}</h3>${html}<div class="row"><button class="btn" onclick="A.fermer()">Annuler</button><button class="btn primary" id="mok">${okLabel}</button></div>`;
  $('#mok').onclick = () => { closeM(); fn(); };
  $('#mbg').classList.add('show');
}
function refuserBox(ids, what) {
  $('#modal').innerHTML = `<h3>Refuser ${esc(what)} ?</h3><p>La ligne part dans « Mis de côté ». Vous pourrez la remettre à traiter à tout moment.</p>
    <textarea id="motif" rows="2" placeholder="Motif (facultatif) : ex. remboursement, client à relancer…"></textarea>
    <div class="row"><button class="btn" onclick="A.fermer()">Annuler</button><button class="btn danger" id="mok">Refuser</button></div>`;
  $('#mok').onclick = async () => { const m = $('#motif').value.trim(); closeM(); await refuser(ids, m); toast('Ligne(s) mise(s) de côté'); };
  $('#mbg').classList.add('show');
}
function annulerBox(id) {
  const l = S.lines.find((x) => x.id === id);
  $('#modal').innerHTML = `<h3>Annuler ce pointage</h3>
    <p>Archie ne permet pas d'annuler un paiement automatiquement. Pour l'annuler :</p>
    <div class="kv"><span>Virement</span><b>${eur(l.credit)} du ${dfr(l.date)}</b><span>Pointé sur</span><b>${esc(l.detail)}</b></div>
    <p>1. Ouvrez la facture dans Archie, menu « Historique ».<br>2. Sur la ligne « Paiement », cliquez sur « … » puis annulez le paiement.<br>3. Relancez l'analyse : la ligne reviendra dans « Prêt à pointer » ou « À vérifier ».</p>
    <div class="row"><button class="btn" onclick="A.fermer()">Fermer</button><button class="btn primary" id="mok">Noter l'annulation demandée</button></div>`;
  $('#mok').onclick = () => { closeM(); demanderAnnulation(id); };
  $('#mbg').classList.add('show');
}
function closeM() { $('#mbg').classList.remove('show'); }
function clore() {
  const todo = inTab('pret').filter((l) => !isOk(l)).length + inTab('verif').filter((l) => !isOk(l)).length;
  confirmBox('Clôturer ce relevé ?', `<p>Le relevé est archivé ; l'écran reviendra à « Aucun relevé à traiter ».</p>${todo ? `<p><b>${todo} ligne(s)</b> restent à traiter : elles réapparaîtront si vous déposez un relevé qui les contient.</p>` : ''}`,
    'Clôturer', async () => {
      const { error } = await sb.from('releves').update({ statut: 'clos', clos_le: new Date().toISOString() }).eq('id', S.releve.id);
      if (error) { toast(`Clôture impossible : ${error.message}`); return; }
      await journal('clôture', { resultat: `Relevé « ${S.releve.fichier} » clôturé` });
      toast(`Relevé « ${S.releve.fichier} » clôturé.`);
      await chargerReleve();
    });
}
function remplirFactures() { $('#invlist').innerHTML = (S?.invoices || []).map((i) => `<option value="${esc(invLabel(i))}">`).join(''); }

// ============================================================================ actions exposées à l'écran
window.A = {
  connexion: () => vueConnexion(),
  choisirFichier: () => $('#fichier').click(),
  recharger: () => chargerReleve(),
  relire: () => { if (S?.status === 'ready' && !S.archieEnCours) analyser({ arrierePlan: true }); },
  onglet: (k) => { TAB = k; SEL = new Set(); render(); },
  tog: (id, on) => { on ? SEL.add(id) : SEL.delete(id); dock(); },
  togAll: (on) => { inTab('pret').filter(match).filter((l) => !isOk(l) && !isBusy(l)).forEach((l) => (on ? SEL.add(l.id) : SEL.delete(l.id))); renderBody(); },
  filtre: (k, v) => { FILT[k] = v; renderBody(); },
  pick: (id, on) => { if (on) PICK.add(id); else { PICK.delete(id); delete OVR[id]; } renderBody(); },
  choisir, montant, validerUne, refuserBox, annulerBox, impMontant, imputerBox, emailBox,
  actualiserRelances, exclureBox, reintegrer, revoquer, enregistrerModele, validerModele,
  vueRelances: async (v) => {
    S.vueRelances = v; renderBody();
    if (v === 'textes') { try { await chargerModeles(); } catch (e) { toast(`Textes non chargés : ${e.message}`); } renderBody(); }
  },
  apercuClient: (cle) => { S.apercuClient = cle; for (const m of S.modeles || []) $(`#ap-${m.code}`).innerHTML = apercu(m); },
  apercuMaj: (code) => { const m = S.modeles.find((x) => x.code === code); $(`#ap-${code}`).innerHTML = apercu(m); },
  vu: (id) => refuser([id], ''),
  remettre,
  fermer: closeM,
};
$('#d-clear').addEventListener('click', () => { SEL = new Set(); renderBody(); });
$('#d-refuser').addEventListener('click', () => { const ids = [...SEL]; refuserBox(ids, `${ids.length} ligne(s)`); });
$('#d-valider').addEventListener('click', validerSel);
$('#b-deposer').addEventListener('click', () => $('#fichier').click());
$('#fichier').addEventListener('change', (e) => deposer(e.target.files[0]));
$('#b-reload').addEventListener('click', () => A.relire());
$('#b-clore').addEventListener('click', clore);
$('#b-excel').addEventListener('click', () => excelBox());
$('#b-out').addEventListener('click', async () => { await sb.auth.signOut(); courant = null; vueConnexion(); });
$('#nom').addEventListener('change', async (e) => {
  const nom = e.target.value.trim().slice(0, 40);
  const { error } = await sb.from('profils').update({ nom }).eq('id', USER.id);
  toast(error ? `Nom non enregistré : ${error.message}` : 'Nom enregistré');
});
$('#mbg').addEventListener('click', (e) => { if (e.target.id === 'mbg') closeM(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeM(); });
window.addEventListener('beforeunload', (e) => { if (S?.sending) { e.preventDefault(); e.returnValue = ''; } });

// ============================================================================ démarrage
(async function demarrer() {
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !window.supabase || !XLSX) return vueConfig();
  sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth: { persistSession: true, detectSessionInUrl: true } });
  window.sb = sb; // diagnostic depuis la console
  const { data } = await sb.auth.getSession();
  await afficher(data.session);
  sb.auth.onAuthStateChange((evt, session) => { if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT') afficher(session); });
})();
