// Lecture du relevé bancaire Excel (un onglet par compte) — portage fidèle de src_reference/releve.py.
// Formats reconnus par les en-têtes ; à défaut, onglet sans en-tête « date | libellé | montant signé ».
// Le fichier est lu dans le navigateur : seules les lignes utiles sont ensuite enregistrées.

const S = (x) => (x === null || x === undefined ? '' : String(x).trim());
export const unidecode = (t) => String(t)
  .replace(/[œŒæÆßøØ]/g, (c) => ({ œ: 'oe', Œ: 'OE', æ: 'ae', Æ: 'AE', ß: 'ss', ø: 'o', Ø: 'O' }[c]))
  .normalize('NFD').replace(/[̀-ͯ]/g, '');
const key = (h) => unidecode(S(h)).toLowerCase().replace(/[^a-z]/g, '');
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function D(XLSX, cell) {
  if (!cell) return null;
  if (cell.t === 'd' && cell.v instanceof Date) return iso(cell.v.getFullYear(), cell.v.getMonth() + 1, cell.v.getDate());
  if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) { const p = XLSX.SSF.parse_date_code(cell.v); return iso(p.y, p.m, p.d); }
  if (cell.t === 's') {
    const s = cell.v.trim().slice(0, 10);
    let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (m) return iso(m[3], m[2], m[1]);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/); if (m) return iso(m[1], m[2], m[3]);
    m = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/); if (m) return iso(2000 + +m[3], m[2], m[1]);
  }
  return null;
}

function N(cell) {
  if (!cell || cell.v === '' || cell.v === null || cell.v === undefined) return 0;
  if (typeof cell.v === 'number') return cell.v;
  const t = String(cell.v).replace(/[   €]/g, '').replace(',', '.');
  return /^-?\d*\.?\d+$/.test(t) ? parseFloat(t) : 0;
}

function find(hdr, ...names) {
  for (const n of names) { const i = hdr.indexOf(n); if (i >= 0) return i; }
  for (const n of names) { const i = hdr.findIndex((h) => h.includes(n)); if (i >= 0) return i; }
  return null;
}

async function sha1(texte) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(texte));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param XLSX  bibliothèque SheetJS
 * @param data  contenu du fichier (ArrayBuffer)
 * @returns {Promise<{lignes: Array, avertissements: string[]}>}
 *   ligne : { id, banque, ligne, date (AAAA-MM-JJ), libelle, info, texte, credit, debit }
 */
export async function lireReleve(XLSX, data) {
  const wb = XLSX.read(data, { type: 'array', cellDates: false, cellNF: true });
  const out = [], warn = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws['!ref']) continue;
    const rg = XLSX.utils.decode_range(ws['!ref']);
    const rows = [];
    for (let r = rg.s.r; r <= rg.e.r; r++) {
      const row = [];
      for (let c = 0; c <= rg.e.c; c++) row.push(ws[XLSX.utils.encode_cell({ r, c })]);
      rows.push(row);
    }
    if (!rows.length) continue;
    const banque = name.trim();
    const hdr = rows[0].map((c) => key(c ? c.v : ''));
    let start = 1;
    let cDate = find(hdr, 'datedevaleur', 'dateoperation', 'datecomptable', 'date');
    let cLib = find(hdr, 'motifs', 'libellesimplifie', 'libelle', 'motif');
    let cInfo = find(hdr, 'informationscomplementaires');
    const cCr = find(hdr, 'credit'), cDb = find(hdr, 'debit');
    let cAmt = null;
    if (cDate === null || cLib === null || (cCr === null && cDb === null)) {
      const first = rows.find((r) => r && D(XLSX, r[0]));
      if (!first || first.length < 3) { warn.push(`Onglet « ${banque} » ignoré : format non reconnu`); continue; }
      cDate = 0; cLib = 1; cAmt = 2; cInfo = null; start = 0;
    }
    for (let i = start; i < rows.length; i++) {
      const r = rows[i];
      if (!r || r.length <= cLib) continue;
      const d = cDate < r.length ? D(XLSX, r[cDate]) : null;
      if (!d) continue;
      let cr, db;
      if (cAmt !== null) { const a = N(r[cAmt]); [cr, db] = a > 0 ? [a, 0] : [0, -a]; }
      else { cr = cCr !== null ? N(r[cCr]) : 0; db = cDb !== null ? N(r[cDb]) : 0; }
      const lib = S(r[cLib] && r[cLib].v);
      const info = cInfo !== null ? S(r[cInfo] && r[cInfo].v) : '';
      out.push({
        banque, ligne: i + 1, date: d, libelle: lib, info, texte: (lib + ' ' + info).trim(),
        credit: Math.round(cr * 100) / 100, debit: Math.round(db * 100) / 100,
      });
    }
  }
  // identifiant stable d'une opération (même si elle réapparaît dans un relevé suivant)
  const seen = new Map();
  for (const l of out) {
    const txt = l.texte.toUpperCase().replace(/\s+/g, ' ');
    const base = `${l.banque}|${l.date}|${l.credit.toFixed(2)}|${l.debit.toFixed(2)}|${txt}`;
    seen.set(base, (seen.get(base) || 0) + 1);
    l.id = (await sha1(`${base}|${seen.get(base)}`)).slice(0, 10);
  }
  return { lignes: out, avertissements: warn };
}
