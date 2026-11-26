// Rapprochement relevé bancaire <-> factures Archie — portage fidèle de src_reference/engine.py.
// Pur calcul : aucune écriture. Les dates sont des chaînes AAAA-MM-JJ.
import { unidecode } from './releve.js';

export const TOL = 0.05;
const TAG_RE = /\[RAPPRO:([0-9a-f]{10})\]/;

export const PROBLEMES = {
  confirmer: 'Facture à confirmer',
  partiel: 'Montant insuffisant',
  trop: 'Trop payé',
  doublon: 'Doublon possible',
  different: 'Montant différent',
  inconnu: 'Payeur inconnu',
  archie: 'Saisi dans Archie sans virement',
};
const MOTIFS_COTE = {
  'Remise CB': 'Remise carte bancaire', 'Titres-restaurant': 'Titres-restaurant',
  'Virement interne': 'Virement interne', 'Opération bancaire': 'Opération bancaire',
};

const S = (x) => (x === null || x === undefined ? '' : String(x));
export const norm = (t) => unidecode(S(t)).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const split = (s) => s.split(' ').filter(Boolean); // équivalent de str.split() sur une chaîne normalisée
const dn = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
const days = (a, b) => dn(a) - dn(b);
const addDays = (iso, n) => new Date((dn(iso) + n) * 86400000).toISOString().slice(0, 10);
const r2 = (x) => Math.round(x * 100) / 100;

/** '2026-11-12T23:00:00' (UTC) -> date locale Paris '2026-11-13' */
const FMT_PARIS = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
export function parisDate(utc) {
  if (!utc) return null;
  const d = new Date(utc.slice(0, 19) + 'Z');
  return Number.isNaN(d.getTime()) ? null : FMT_PARIS.format(d);
}

export function categ(l) {
  const t = l.texte.toUpperCase();
  if (l.credit <= 0) return 'Débit';
  if (/CREDIT CARTE|REMISE CB/.test(t)) return 'Remise CB';
  if (/EDENRED|PLUXEE|UP COOP|BIMPL|SOD-TRD|NIT-TRD|CDJ-TRD|ERF-TRD|SWILE|CONECS/.test(t)) return 'Titres-restaurant';
  if (/THE BUREAU THEMIS|TRESORERIE INTERNE|REGUL SOLDE COMPTE|VIR SEPA THE BUREAU/.test(t)) return 'Virement interne';
  if (/^RETOUR |EUROPREL|ANN\.ECH|^GAB |IMPAYE|ANNUL COTIS|REMBOURSEMENT COTISATION|^FACTURE NUM/.test(t)) return 'Opération bancaire';
  if (/IPID EUROPE/.test(t) && l.credit < 1) return 'Opération bancaire';
  return 'Client';
}

export function refs(text) {
  const c = unidecode(text).toUpperCase().replace(/[\s\-_/.:]/g, '');
  const res = [];
  for (const m of c.matchAll(/(FAC|FACT(?:URE)?0([234])|FA0?([234])|0([234]))2026(\d{6}|\d{4}(?!\d))/g)) {
    const p = m[1] === 'FAC' ? 'FAC' : 'FA0' + (m[2] || m[3] || m[4]);
    res.push([p, m[5].padStart(6, '0')]);
  }
  for (const m of c.matchAll(/(?<!\d)2026(\d{6})(?!\d)/g)) {
    if (!res.some((r) => r[1] === m[1])) res.push(['?', m[1]]);
  }
  const vus = new Set();
  return res.filter((r) => { const k = r.join('|'); if (vus.has(k)) return false; vus.add(k); return true; });
}

const STOP = new Set('SAS SARL SA SASU SCI EURL SC SELARL SELAS SNC LLC LTD LIMITED GMBH BV NV INC SPV SL SLP EI THE BUREAU FRANCE PARIS GROUPE GROUP CAPITAL PARTNERS INVEST INVESTMENT CONSEIL CONSULTING HOLDING FINANCE INTERNATIONAL EUROPE SOCIETE COMPAGNIE ET DE DU DES LA LE LES AND OF MONSIEUR MADAME MME M MR'.split(' '));
const FORMES = new Set(['SAS', 'SARL', 'SA', 'SASU', 'SCI', 'EURL', 'THE']);

export function core(name) {
  const allt = split(norm(name));
  let c = allt.filter((t) => !STOP.has(t) && t.length > 1).join(' ');
  if (c.length < 4) c = allt.filter((t) => !FORMES.has(t)).join(' ');
  return c;
}

export function variants(name) {
  if (!name) return [];
  const parts = [name, ...[...name.matchAll(/\(([^()]*)\)/g)].map((m) => m[1]), name.replace(/\([^()]*\)/g, ' ')];
  const out = [];
  for (const p of parts) {
    if (!split(norm(p)).some((t) => !STOP.has(t) && t.length > 1)) continue;
    const c = core(p);
    if (c.length >= 3 && !out.includes(c)) out.push(c);
  }
  return out;
}

function tokScore(c, btoks) {
  const toks = split(c).filter((t) => t.length >= 2).slice(0, 4);
  if (!toks.length) return 0;
  const bset = new Set(btoks);
  const found = (t) => {
    if (bset.has(t)) return 'exact';
    if (t.length < 4) return null;
    for (const b of btoks) {
      const n = Math.min(t.length, b.length);
      if (n >= 4 && t.slice(0, n) === b.slice(0, n)) return 'prefix' + n;
    }
    return null;
  };
  const res = new Map(toks.map((t) => [t, found(t)]));
  const f = toks.filter((t) => res.get(t));
  const strong = f.filter((t) => res.get(t) === 'exact' || +res.get(t).slice(6) >= 5);
  if (f.length === toks.length) {
    if (toks.length > 1 && strong.some((t) => !STOP.has(t))) return 100;
    if (toks.length === 1 && toks[0].length >= 5 && strong.length) return 100;
  }
  const strong2 = strong.filter((t) => !STOP.has(t));
  if (strong2.length && Math.max(...strong2.map((t) => t.length)) >= 7 && f.length * 2 >= toks.length) return 90;
  return 0;
}

// ---- fuzz.partial_ratio (sémantique rapidfuzz) : on n'a besoin que du test « >= 95 ».
function lcs(a, b) {
  const m = b.length; let prev = new Array(m + 1).fill(0), cur = new Array(m + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  return prev[m];
}
function partialAtLeast95Dir(s1, s2) { // s1 = aiguille (la plus courte)
  const n = s1.length, L = s2.length;
  if (!n || !L) return false;
  // Filtre exact : au plus E = floor(0.1 n) modifications ⇒ un des E+1 morceaux de s1 figure tel quel dans s2.
  const k = Math.floor(0.1 * n) + 1;
  let ok = false;
  for (let i = 0; i < k && !ok; i++) if (s2.includes(s1.slice(Math.floor(i * n / k), Math.floor((i + 1) * n / k)))) ok = true;
  if (!ok) return false;
  const win = [];
  for (let i = 1; i < n; i++) win.push(s2.slice(0, i));
  for (let i = 0; i + n <= L; i++) win.push(s2.slice(i, i + n));
  for (let i = Math.max(L - n + 1, 1); i < L; i++) win.push(s2.slice(i));
  for (const w of win) if (200 * lcs(s1, w) / (n + w.length) >= 95) return true;
  return false;
}
function partialAtLeast95(a, b) {
  if (a.length > b.length) [a, b] = [b, a];
  if (partialAtLeast95Dir(a, b)) return true;
  return a.length === b.length && partialAtLeast95Dir(b, a);
}

const cacheScore = new Map();
export function nameScore(vs, textNorm) {
  vs = Array.isArray(vs) ? vs : [vs];
  const cle = vs.join('\u0002') + '\u0001' + textNorm;
  if (cacheScore.has(cle)) return cacheScore.get(cle);
  const btoks = split(textNorm);
  let best = 0;
  for (const c of vs) {
    if (!c || c.length < 3) continue;
    const strict = split(c).filter((t) => !STOP.has(t) && t.length > 1).join(' ');
    let s = strict.length >= 8 && partialAtLeast95(strict, textNorm) ? 95 : 0;
    if (c.length < 5 && new RegExp('\\b' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(textNorm)) s = 95;
    best = Math.max(best, s, tokScore(c, btoks));
  }
  if (cacheScore.size > 500000) cacheScore.clear();
  cacheScore.set(cle, best);
  return best;
}

function subsetExact(items, target, maxn = 6) {
  items = items.slice(0, 14);
  const lim = Math.min(maxn, items.length);
  for (let n = 1; n <= lim; n++) {
    const idx = [];
    const rec = (start) => {
      if (idx.length === n) {
        let s = 0; for (const i of idx) s += items[i][0];
        return Math.abs(s - target) <= TOL ? idx.map((i) => items[i][1]) : null;
      }
      for (let i = start; i < items.length; i++) { idx.push(i); const r = rec(i + 1); idx.pop(); if (r) return r; }
      return null;
    };
    const r = rec(0);
    if (r) return r;
  }
  return null;
}

export const fr = (x) => {
  const [e, d] = Math.abs(x).toFixed(2).split('.');
  return (x < 0 ? '-' : '') + e.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + d + ' €';
};

const byKey = (keyFn) => (a, b) => { const ka = keyFn(a), kb = keyFn(b); for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; } return 0; };

// ============================================================================ analyse
/**
 * @param bank       lignes du relevé (lireReleve)
 * @param inv        factures Archie (fonction archie-donnees)
 * @param pay        paiements Archie
 * @param decisions  { op_id: { refus, motif, annulation_demandee } }
 * @returns { lines, orphelins, invoices }
 */
export function run(bank, inv, pay, decisions) {
  for (const i of inv) {
    const m = (i.ref || '').match(/^(FAC|FA0\d)-2026-(\d+)/);
    i.key = m ? [m[1], m[2].padStart(6, '0')] : null;
    i.reste_cur = i.reste;
    i.core = core(i.client);
    i.vars = variants(i.client);
    i.core_mgr = i.manager ? core(i.manager) : '';
  }
  const byKeyMap = new Map(), byNum = new Map();
  for (const i of inv) if (i.key) byKeyMap.set(i.key.join('|'), i);
  for (const i of inv) if (i.key) { if (!byNum.has(i.key[1])) byNum.set(i.key[1], []); byNum.get(i.key[1]).push(i); }
  const invByUuid = new Map(inv.map((i) => [i.uuid, i]));

  const lines = bank.filter((l) => l.credit > 0).map((l) => ({ ...l }));
  for (const l of lines) { l.cat = categ(l); l.norm = norm(l.texte); l.refs = refs(l.texte); l.props = []; l.tab = null; }
  const clients = lines.filter((l) => l.cat === 'Client');

  // ---- paiements Archie utilisables
  const ex = pay.filter((p) => p.status === 'succeeded' && !['credit-note', 'invoice'].includes(p.compte));
  for (const p of ex) { p.used = false; p.d = parisDate(p.date); const m = TAG_RE.exec(p.note || ''); p.tag = m ? m[1] : null; }

  // ---- 0. lignes déjà pointées par l'outil (repère dans la note du paiement)
  const tagged = new Map();
  for (const p of ex) if (p.tag) { if (!tagged.has(p.tag)) tagged.set(p.tag, []); tagged.get(p.tag).push(p); }
  for (const l of clients) {
    if (tagged.has(l.id)) {
      const ps = tagged.get(l.id);
      for (const p of ps) p.used = true;
      l.tab = 'deja'; l.origine = "Pointé par l'outil"; l.deja = ps;
    }
  }

  // ---- 1. lignes déjà pointées à la main dans Archie
  const payCore = (p) => (p._vars ??= variants(p.client));
  const linked = (p, l) => {
    if (p.facture) {
      const m = p.facture.match(/^(FAC|FA0\d)-\d{4}-(\d+)/);
      if (m) {
        const num = m[2].padStart(6, '0');
        for (const [a, b] of l.refs) if (b === num && (a === '?' || a === m[1])) return true;
      }
    }
    return nameScore(payCore(p), l.norm) >= 90;
  };
  for (const passe of [1, 2]) {
    const ordre = [...clients].sort(byKey((x) => [x.refs.length ? 0 : 1, x.date]));
    for (const l of ordre) {
      if (l.tab) continue;
      const cand = ex.filter((p) => !p.used && p.d && Math.abs(days(p.d, l.date)) <= 12);
      if (!cand.length) continue;
      let hit = null;
      if (passe === 1) {
        const lk = cand.filter((p) => linked(p, l)).sort(byKey((p) => [Math.abs(days(p.d, l.date))]));
        for (const p of lk) if (Math.abs(p.montant - l.credit) <= TOL) { hit = [p]; break; }
        if (!hit && lk.length) hit = subsetExact(lk.map((p) => [p.montant, p]), l.credit);
        if (!hit) {
          const btok = new Set(split(l.norm));
          for (const p of [...cand].sort(byKey((p) => [Math.abs(days(p.d, l.date))]))) {
            if (Math.abs(p.montant - l.credit) > TOL || Math.abs(days(p.d, l.date)) > 7) continue;
            const ptok = new Set(payCore(p).flatMap((v) => split(v)).filter((t) => t.length >= 3 && !STOP.has(t)));
            if ([...ptok].some((t) => btok.has(t))) { hit = [p]; break; }
          }
        }
      } else {
        const win = l.credit >= 150 ? 5 : 2;
        const same = cand.filter((p) => Math.abs(p.montant - l.credit) <= TOL && Math.abs(days(p.d, l.date)) <= win);
        const twins = clients.filter((x) => !x.tab && Math.abs(x.credit - l.credit) <= TOL && Math.abs(days(x.date, l.date)) <= Math.max(win * 2, 6));
        if (same.length === 1 && twins.length === 1) hit = same;
      }
      if (hit) {
        for (const p of hit) p.used = true;
        l.tab = 'deja';
        l.origine = hit.some((p) => (p.note || '').includes('RAPPRO')) ? "Pointé par l'outil" : 'Saisi dans Archie';
        l.deja = hit;
      }
    }
  }
  for (const l of lines) {
    if (l.tab === 'deja') {
      l.detail = l.deja.map((p) => `${p.facture || 'paiement non affecté'} · ${fr(p.montant)} · le ${p.saisi.slice(8, 10)}/${p.saisi.slice(5, 7)}/${p.saisi.slice(0, 4)}`).join(' ; ');
      l.paiements_archie = l.deja.map((p) => ({ uuid: p.uuid, facture: p.facture, montant: p.montant }));
      delete l.deja;
    }
  }

  // ---- 2. rapprochement des virements restants
  const add = (l, i, montant, comment = '') => {
    montant = r2(montant);
    l.props.push({
      uuid: i.uuid, space: i.space, ref: i.ref, client: i.client, site: i.site, ttc: i.ttc,
      reste_avant: r2(i.reste_cur), montant, reste_apres: r2(i.reste_cur - montant), commentaire: comment,
    });
    i.reste_cur = r2(i.reste_cur - montant);
  };
  const allocate = (l, invs) => {
    invs = [...invs].sort(byKey((i) => [i.date, i.ref || '']));
    const tot = r2(invs.reduce((s, i) => s + i.reste_cur, 0));
    const A = l.credit;
    if (Math.abs(A - tot) <= TOL) { for (const i of invs) add(l, i, i.reste_cur); return ['ok', 0]; }
    if (A < tot) {
      let rest = A;
      for (const i of invs) { if (rest <= TOL) break; const m = Math.min(rest, i.reste_cur); add(l, i, m); rest -= m; }
      return ['partiel', r2(A - tot)];
    }
    const surplus = r2(A - tot);
    const cores = new Set(invs.map((i) => i.core));
    const dans = new Set(invs);
    const others = inv.filter((i) => i.reste_cur > TOL && !dans.has(i) && cores.has(i.core) && ['open', 'partially_paid'].includes(i.state));
    const sub = subsetExact([...others].sort(byKey((i) => [i.date])).map((i) => [i.reste_cur, i]), surplus);
    for (const i of invs) add(l, i, i.reste_cur);
    if (sub) { for (const i of sub) add(l, i, i.reste_cur, 'non citée dans le libellé'); return ['surplus', 0]; }
    return ['trop', surplus];
  };
  const setVerif = (l, kind, ecart, texte) => { l.tab = 'verif'; l.probleme = PROBLEMES[kind]; l.ecart = ecart; l.detail = texte; };

  const order = clients.filter((l) => !l.tab).sort(byKey((x) => [x.refs.length ? 0 : 1, x.date, -x.credit]));
  for (const l of order) {
    const A = l.credit;
    let found = [];
    for (const [p, n] of l.refs) {
      if (p !== '?') {
        const i = byKeyMap.get(p + '|' + n);
        if (i) found.push(i);
      } else {
        let c = byNum.get(n) || [];
        if (c.length > 1) {
          let c2 = c.filter((i) => nameScore(i.vars, l.norm) >= 88);
          if (!c2.length) c2 = c.filter((i) => Math.abs(i.reste_cur - A) <= TOL);
          c = c2.length === 1 ? c2 : [];
        }
        if (c.length === 1) found.push(c[0]);
      }
    }
    found = [...new Set(found)];
    if (found.length) {
      const openf = found.filter((i) => i.reste_cur > TOL && i.state !== 'draft');
      const closed = found.filter((i) => !openf.includes(i));
      if (openf.length) {
        const [res, gap] = allocate(l, openf);
        if (res === 'ok') { l.tab = 'pret'; l.regle = 'N° de facture dans le libellé'; }
        else if (res === 'partiel') setVerif(l, 'partiel', gap, `Virement de ${fr(A)} pour ${fr(A - gap)} dus : pointer le montant reçu, il restera ${fr(-gap)} à réclamer`);
        else if (res === 'trop') {
          const note = closed.length ? ' · déjà soldée : ' + closed.map((i) => i.ref).join(', ') : '';
          setVerif(l, 'trop', gap, `Facture soldée, ${fr(gap)} reçus en trop à affecter ou rembourser${note}`);
        } else setVerif(l, 'confirmer', 0, "Le surplus du virement solde exactement d'autres factures du même client, non citées dans le libellé");
      } else {
        setVerif(l, 'doublon', A, 'Facture déjà payée dans Archie : ' + closed.map((i) => `${i.ref}`).join(', ') + ' — vérifier le paiement saisi');
      }
      continue;
    }
    const scored = new Map();
    for (const i of inv) {
      if (i.reste_cur <= TOL || i.state === 'draft') continue;
      const s = Math.max(nameScore(i.vars, l.norm), split(i.core_mgr).length >= 2 ? nameScore(i.core_mgr, l.norm) - 5 : 0);
      if (s >= 88) { if (!scored.has(i.core)) scored.set(i.core, []); scored.get(i.core).push([s, i]); }
    }
    if (scored.size) {
      let best = null, bestS = -Infinity;
      for (const v of scored.values()) { const m = Math.max(...v.map(([s]) => s)); if (m > bestS) { bestS = m; best = v; } }
      let base = best.filter(([, i]) => i.date <= l.date).map(([, i]) => i);
      if (!base.length) base = best.map(([, i]) => i);
      const cinv = [...base].sort(byKey((i) => [i.date]));
      const exact = cinv.filter((i) => Math.abs(i.reste_cur - A) <= TOL);
      if (exact.length) {
        add(l, exact[0], A);
        if (exact.length === 1) { l.tab = 'pret'; l.regle = 'Nom du client et montant exact'; }
        else setVerif(l, 'confirmer', 0, `${exact.length} factures ouvertes du même montant pour ce client : la plus ancienne est proposée`);
        continue;
      }
      const sub = subsetExact(cinv.map((i) => [i.reste_cur, i]), A);
      if (sub) {
        for (const i of sub) add(l, i, i.reste_cur);
        l.tab = 'pret';
        l.regle = sub.length > 1 ? `Nom du client, ${sub.length} factures réglées par un seul virement` : 'Nom du client et montant exact';
        continue;
      }
      const tot = r2(cinv.reduce((s, i) => s + i.reste_cur, 0));
      setVerif(l, 'different', r2(A - tot), `${cinv[0].client} : ${cinv.length} facture(s) ouverte(s) pour ${fr(tot)} (` + cinv.slice(0, 5).map((i) => `${i.ref} ${fr(i.reste_cur)}`).join(', ') + ')');
      continue;
    }
    const same = inv.filter((i) => i.reste_cur > TOL && i.state !== 'draft' && Math.abs(i.reste_cur - A) <= TOL && i.date <= l.date);
    if (same.length === 1) {
      add(l, same[0], A);
      setVerif(l, 'confirmer', 0, `Même montant que ${same[0].ref} (${same[0].client}), mais le nom du payeur ne correspond pas`);
      continue;
    }
    setVerif(l, 'inconnu', A, same.length ? `Aucune facture ouverte ne correspond (${same.length} facture(s) du même montant)` : 'Aucune facture ouverte ne correspond');
  }

  for (const l of lines) if (l.cat !== 'Client') { l.tab = 'cote'; l.motif = MOTIFS_COTE[l.cat]; l.detail = ''; }

  // ---- 3. refus des utilisateurs
  for (const l of lines) {
    const d = decisions[l.id];
    if (d && d.refus && (l.tab === 'pret' || l.tab === 'verif')) {
      for (const p of l.props) { const i = invByUuid.get(p.uuid); if (i) i.reste_cur += p.montant; }
      l.tab_origine = l.tab; l.tab = 'cote';
      l.motif = 'Refusé' + (d.motif ? ` : ${d.motif}` : '');
      l.refuse = true;
    }
  }

  // ---- 4. paiements Archie sans virement dans la période du relevé
  const cdates = clients.map((l) => l.date).sort();
  const orphelins = [];
  if (cdates.length) {
    const dmin = cdates[0], dmax = cdates[cdates.length - 1], dmin2 = addDays(dmin, 2);
    const cnt = new Map();
    for (const p of ex) if (p.facture) cnt.set(p.facture, (cnt.get(p.facture) || 0) + 1);
    for (const p of ex) {
      if (p.used || !p.d || p.d < dmin2 || p.d > dmax) continue;
      let obs = 'Aucun virement correspondant dans le relevé';
      if (p.facture && cnt.get(p.facture) > 1) obs = `Facture payée ${cnt.get(p.facture)} fois dans Archie : doublon probable`;
      const oid = 'A' + p.uuid.replace(/-/g, '').slice(0, 9);
      const d = decisions[oid];
      orphelins.push({ id: oid, date: p.d, montant: p.montant, facture: p.facture || '—', client: p.client, site: p.site, saisi: p.saisi, detail: obs, vu: Boolean(d && d.refus) });
    }
  }
  return { lines, orphelins, invoices: inv };
}
