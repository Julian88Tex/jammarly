/**
 * Rule `consistency_spelling_variant`: US vs UK spellings. en-US expects US forms; en-GB, en-CA, en-AU
 * and en-IN expect UK forms. Mixed usage of one family is also flagged toward the majority form.
 *
 * Deliberately absent: program/programme (computing), license/licence and practice/practise (UK
 * noun/verb split), dialog/analog (computing), aesthetic/archaeology/judgment/inquiry (both accepted
 * in US), whisky/whiskey (different drinks), check/cheque is one-directional (see `ambiguousUs`).
 */
import type { Dialect } from '../types';
import type { RuleContext } from './context';
import { isDigit, isLetter, isUpper, isWordChar, matchCase } from './context';

export interface SpellingVariant {
  us: string;
  uk: string;
  /** Family id (base word) shared by all inflections of one pair. */
  family: string;
}

interface Family {
  us: string[];
  uk: string[];
  /** The US form has other meanings in UK English (tire, check, curb, story); flag only the UK form. */
  ambiguousUs?: boolean;
}

function ize(stem: string, withNoun = true): Family {
  const sfx = withNoun ? ['ize', 'izes', 'ized', 'izing', 'ization', 'izations'] : ['ize', 'izes', 'ized', 'izing'];
  return { us: sfx.map((s) => stem + s), uk: sfx.map((s) => stem + s.replace('iz', 'is')) };
}
function yze(stem: string): Family {
  const sfx = ['yze', 'yzes', 'yzed', 'yzing'];
  return { us: sfx.map((s) => stem + s), uk: sfx.map((s) => stem + s.replace('yz', 'ys')) };
}
function our(stem: string, extra: [string, string][] = []): Family {
  const us = [stem + 'or', stem + 'ors'];
  const uk = [stem + 'our', stem + 'ours'];
  for (const [a, b] of extra) {
    us.push(a);
    uk.push(b);
  }
  return { us, uk };
}
function pair(us: string, uk: string, ambiguousUs = false): Family {
  return { us: [us], uk: [uk], ambiguousUs };
}
function pairs(list: [string, string][], ambiguousUs = false): Family {
  return { us: list.map((p) => p[0]), uk: list.map((p) => p[1]), ambiguousUs };
}

const IZE_STEMS = [
  'organ', 'real', 'recogn', 'apolog', 'minim', 'maxim', 'optim', 'priorit', 'custom', 'summar', 'emphas', 'critic',
  'final', 'util', 'categor', 'special', 'standard', 'author', 'memor', 'visual', 'normal', 'general', 'capital',
  'character', 'civil', 'colon', 'digit', 'econom', 'equal', 'familiar', 'fertil', 'formal', 'harmon', 'hospital',
  'ideal', 'immun', 'industrial', 'internal', 'legal', 'local', 'material', 'mobil', 'modern', 'monet', 'moral',
  'neutral', 'patron', 'penal', 'personal', 'popular', 'privat', 'public', 'random', 'rational', 'revolution',
  'sanit', 'satir', 'scrutin', 'sensit', 'serial', 'social', 'stabil', 'steril', 'stigmat', 'subsid', 'symbol',
  'sympath', 'synchron', 'synthes', 'terror', 'theor', 'trivial', 'urban', 'vandal', 'verbal', 'victim',
  'western', 'central', 'commercial', 'dramat', 'energ', 'external', 'global', 'initial', 'item', 'jeopard',
  'legitim', 'liberal', 'magnet', 'mechan', 'metabol', 'national', 'oxid', 'pasteur', 'plagiar', 'polar', 'pressur',
  'pulver', 'radical', 'secular', 'sexual', 'traumat', 'vocal', 'vulgar', 'weapon', 'winter', 'monopol', 'parallel',
  'philosoph', 'carbon', 'caramel', 'crystall', 'decimal', 'demon', 'deodor', 'epitom', 'fantas', 'fossil', 'galvan',
  'glamor', 'hypothes', 'incentiv', 'individual', 'ion', 'lion', 'mesmer', 'mythol', 'ostrac', 'rhapsod', 'ritual',
  'romantic', 'scandal', 'sermon', 'solemn', 'tyrann', 'vapor', 'actual', 'agon', 'alphabet', 'american', 'brutal',
  'cannibal', 'computer', 'contextual', 'democrat', 'dehuman', 'dramat', 'editorial', 'empath', 'evangel', 'fictional',
  'fluid', 'hybrid', 'idol', 'immortal', 'legal', 'marginal', 'maxim', 'militar', 'miniatur', 'nominal',
  'operational', 'plural', 'professional', 'regular', 'rubber', 'sensational', 'tender', 'token', 'union',
  'commodit', 'conceptual', 'container', 'criminal', 'destabil', 'digital', 'fratern',
];

const FAMILIES: Family[] = [
  // -ize / -ise (verbs where US has -ize and UK -ise; -ise-only words like advertise/surprise are absent)
  ...IZE_STEMS.filter((s, i, a) => a.indexOf(s) === i && !/(is|iz)$/.test(s)).map((s) => ize(s)),
  ...['anal', 'paral', 'catal', 'hydrol', 'electrol', 'breathal', 'dial'].map(yze),
  // -or / -our
  our('col', [['colored', 'coloured'], ['coloring', 'colouring'], ['colorful', 'colourful'], ['colorless', 'colourless'], ['discolor', 'discolour'], ['discolored', 'discoloured'], ['watercolor', 'watercolour'], ['watercolors', 'watercolours']]),
  our('hon', [['honored', 'honoured'], ['honoring', 'honouring'], ['honorable', 'honourable'], ['dishonor', 'dishonour'], ['dishonored', 'dishonoured']]),
  our('fav', [['favored', 'favoured'], ['favoring', 'favouring'], ['favorite', 'favourite'], ['favorites', 'favourites'], ['favorable', 'favourable'], ['favorably', 'favourably'], ['unfavorable', 'unfavourable']]),
  our('flav', [['flavored', 'flavoured'], ['flavoring', 'flavouring'], ['flavorful', 'flavourful'], ['flavorings', 'flavourings']]),
  our('hum', [['humored', 'humoured'], ['humoring', 'humouring'], ['humorless', 'humourless']]),
  our('lab', [['labored', 'laboured'], ['laboring', 'labouring'], ['laborer', 'labourer'], ['laborers', 'labourers']]),
  our('neighb', [['neighborhood', 'neighbourhood'], ['neighborhoods', 'neighbourhoods'], ['neighboring', 'neighbouring'], ['neighborly', 'neighbourly']]),
  our('behavi', [['behavioral', 'behavioural'], ['misbehavior', 'misbehaviour']]),
  our('harb', [['harbored', 'harboured'], ['harboring', 'harbouring']]),
  our('rum', [['rumored', 'rumoured']]),
  our('val'), our('vig'), our('sav', [['savored', 'savoured'], ['savory', 'savoury']]), our('od', [['odorless', 'odourless']]),
  our('arm', [['armored', 'armoured'], ['armory', 'armoury']]), our('cand'), our('clam', [['clamored', 'clamoured']]),
  our('endeav', [['endeavored', 'endeavoured'], ['endeavoring', 'endeavouring']]), our('ferv'), our('parl'), our('ranc'),
  our('splend'), our('tum', [['tumorous', 'tumourous']]), our('demean'), our('ard'), our('savi'), our('succ'),
  pairs([['mold', 'mould'], ['molds', 'moulds'], ['molded', 'moulded'], ['molding', 'moulding'], ['moldy', 'mouldy']]),
  pairs([['smolder', 'smoulder'], ['smoldering', 'smouldering'], ['smoldered', 'smouldered']]),
  // -er / -re
  pairs([['center', 'centre'], ['centers', 'centres'], ['centered', 'centred'], ['centering', 'centring'], ['centerpiece', 'centrepiece']]),
  pairs([['kilometer', 'kilometre'], ['kilometers', 'kilometres'], ['centimeter', 'centimetre'], ['centimeters', 'centimetres'], ['millimeter', 'millimetre'], ['millimeters', 'millimetres'], ['micrometer', 'micrometre'], ['nanometer', 'nanometre']]),
  pairs([['theater', 'theatre'], ['theaters', 'theatres'], ['theatergoer', 'theatregoer']]),
  pairs([['fiber', 'fibre'], ['fibers', 'fibres'], ['fiberglass', 'fibreglass'], ['fiberoptic', 'fibreoptic']]),
  pairs([['liter', 'litre'], ['liters', 'litres'], ['milliliter', 'millilitre'], ['milliliters', 'millilitres']]),
  pairs([['saber', 'sabre'], ['sabers', 'sabres']]), pairs([['somber', 'sombre']]), pairs([['luster', 'lustre']]),
  pairs([['specter', 'spectre'], ['specters', 'spectres']]), pairs([['caliber', 'calibre'], ['calibers', 'calibres']]),
  pairs([['maneuver', 'manoeuvre'], ['maneuvers', 'manoeuvres'], ['maneuvered', 'manoeuvred'], ['maneuvering', 'manoeuvring'], ['maneuverable', 'manoeuvrable'], ['maneuverability', 'manoeuvrability']]),
  pairs([['sepulcher', 'sepulchre'], ['meager', 'meagre'], ['ocher', 'ochre'], ['miter', 'mitre'], ['reconnoiter', 'reconnoitre'], ['goiter', 'goitre'], ['louver', 'louvre']]),
  // -se / -ce
  pairs([['defense', 'defence'], ['defenses', 'defences'], ['offense', 'offence'], ['offenses', 'offences'], ['pretense', 'pretence'], ['pretenses', 'pretences']]),
  // -og / -ogue
  pairs([['catalog', 'catalogue'], ['catalogs', 'catalogues'], ['cataloged', 'catalogued'], ['cataloging', 'cataloguing']]),
  // single vs double l
  pairs([['traveling', 'travelling'], ['traveled', 'travelled'], ['traveler', 'traveller'], ['travelers', 'travellers']]),
  pairs([['canceled', 'cancelled'], ['canceling', 'cancelling']]),
  pairs([['labeled', 'labelled'], ['labeling', 'labelling']]),
  pairs([['modeled', 'modelled'], ['modeling', 'modelling'], ['modeler', 'modeller']]),
  pairs([['signaled', 'signalled'], ['signaling', 'signalling']]),
  pairs([['fueled', 'fuelled'], ['fueling', 'fuelling'], ['refueled', 'refuelled'], ['refueling', 'refuelling']]),
  pairs([['counselor', 'counsellor'], ['counselors', 'counsellors'], ['counseled', 'counselled'], ['counseling', 'counselling']]),
  pairs([['jeweler', 'jeweller'], ['jewelers', 'jewellers'], ['jewelry', 'jewellery']]),
  pairs([['marvelous', 'marvellous'], ['marveled', 'marvelled'], ['marveling', 'marvelling']]),
  pairs([['woolen', 'woollen'], ['woolens', 'woollens']]),
  pairs([['enrollment', 'enrolment'], ['enrollments', 'enrolments'], ['enroll', 'enrol'], ['enrolls', 'enrols']]),
  pairs([['installment', 'instalment'], ['installments', 'instalments']]),
  pairs([['fulfill', 'fulfil'], ['fulfills', 'fulfils'], ['fulfillment', 'fulfilment']]),
  pairs([['skillful', 'skilful'], ['skillfully', 'skilfully'], ['willful', 'wilful'], ['willfully', 'wilfully']]),
  pairs([['distill', 'distil'], ['distills', 'distils'], ['instill', 'instil'], ['instills', 'instils'], ['enthrall', 'enthral'], ['appall', 'appal']]),
  pairs([['chili', 'chilli'], ['chilies', 'chillies']]),
  pairs([['dialed', 'dialled'], ['dialing', 'dialling'], ['equaled', 'equalled'], ['equaling', 'equalling'], ['quarreled', 'quarrelled'], ['quarreling', 'quarrelling']]),
  pairs([['totaled', 'totalled'], ['totaling', 'totalling'], ['tunneled', 'tunnelled'], ['tunneling', 'tunnelling'], ['channeled', 'channelled'], ['channeling', 'channelling']]),
  pairs([['leveled', 'levelled'], ['leveling', 'levelling'], ['rivaled', 'rivalled'], ['reveled', 'revelled'], ['reveling', 'revelling'], ['shoveled', 'shovelled'], ['groveled', 'grovelled']]),
  pairs([['paneled', 'panelled'], ['panelist', 'panellist'], ['panelists', 'panellists'], ['initialed', 'initialled'], ['pedaled', 'pedalled'], ['spiraled', 'spiralled'], ['spiraling', 'spiralling']]),
  pairs([['unraveled', 'unravelled'], ['unraveling', 'unravelling'], ['unrivaled', 'unrivalled'], ['libeled', 'libelled'], ['dueled', 'duelled'], ['funneled', 'funnelled'], ['funneling', 'funnelling']]),
  pairs([['chiseled', 'chiselled'], ['snorkeling', 'snorkelling'], ['caroling', 'carolling'], ['barreled', 'barrelled'], ['cudgeled', 'cudgelled'], ['gamboled', 'gambolled'], ['yodeled', 'yodelled']]),
  // misc
  pairs([['gray', 'grey'], ['grays', 'greys'], ['grayish', 'greyish'], ['grayer', 'greyer']]),
  pairs([['tire', 'tyre'], ['tires', 'tyres']], true),
  pairs([['check', 'cheque'], ['checks', 'cheques'], ['checkbook', 'chequebook']], true),
  pairs([['curb', 'kerb'], ['curbs', 'kerbs']], true),
  pairs([['story', 'storey'], ['stories', 'storeys']], true),
  pairs([['draft', 'draught'], ['drafts', 'draughts'], ['drafty', 'draughty']], true),
  pairs([['plow', 'plough'], ['plows', 'ploughs'], ['plowed', 'ploughed'], ['plowing', 'ploughing']]),
  pairs([['pajamas', 'pyjamas'], ['pajama', 'pyjama']]),
  pairs([['mustache', 'moustache'], ['mustaches', 'moustaches']]),
  pairs([['aluminum', 'aluminium']]), pairs([['airplane', 'aeroplane'], ['airplanes', 'aeroplanes']]),
  pairs([['skeptic', 'sceptic'], ['skeptics', 'sceptics'], ['skeptical', 'sceptical'], ['skeptically', 'sceptically'], ['skepticism', 'scepticism']]),
  pairs([['sulfur', 'sulphur'], ['sulfate', 'sulphate'], ['sulfates', 'sulphates'], ['sulfuric', 'sulphuric'], ['sulfide', 'sulphide']]),
  pairs([['pediatric', 'paediatric'], ['pediatrics', 'paediatrics'], ['pediatrician', 'paediatrician'], ['pediatricians', 'paediatricians']]),
  pairs([['anesthesia', 'anaesthesia'], ['anesthetic', 'anaesthetic'], ['anesthetics', 'anaesthetics'], ['anesthetist', 'anaesthetist'], ['anesthesiologist', 'anaesthesiologist']]),
  pairs([['anemia', 'anaemia'], ['anemic', 'anaemic'], ['leukemia', 'leukaemia'], ['hemoglobin', 'haemoglobin'], ['hemorrhage', 'haemorrhage'], ['hemorrhoids', 'haemorrhoids'], ['hematology', 'haematology']]),
  pairs([['encyclopedia', 'encyclopaedia'], ['encyclopedias', 'encyclopaedias'], ['orthopedic', 'orthopaedic'], ['orthopedics', 'orthopaedics'], ['gynecology', 'gynaecology'], ['gynecologist', 'gynaecologist']]),
  pairs([['diarrhea', 'diarrhoea'], ['estrogen', 'oestrogen'], ['fetus', 'foetus'], ['fetal', 'foetal'], ['edema', 'oedema'], ['esophagus', 'oesophagus']]),
  pairs([['cozy', 'cosy'], ['cozier', 'cosier'], ['coziest', 'cosiest'], ['cozily', 'cosily']]),
  pairs([['aging', 'ageing']]), pairs([['artifact', 'artefact'], ['artifacts', 'artefacts']]),
  pairs([['specialty', 'speciality'], ['specialties', 'specialities']]), pairs([['math', 'maths']]),
  pairs([['furor', 'furore']]), pairs([['licorice', 'liquorice']]), pairs([['mollusk', 'mollusc'], ['mollusks', 'molluscs']]),
  pairs([['omelet', 'omelette'], ['omelets', 'omelettes']]), pairs([['tidbit', 'titbit'], ['tidbits', 'titbits']]),
  pairs([['yogurt', 'yoghurt'], ['yogurts', 'yoghurts']]), pairs([['carburetor', 'carburettor']]),
  pairs([['garrote', 'garrotte']]), pairs([['phony', 'phoney']]), pairs([['pedophile', 'paedophile']]),
];

interface Entry {
  family: number;
  form: 'us' | 'uk';
  other: string;
  ambiguousUs: boolean;
}

let lookup: Map<string, Entry> | null = null;
let variants: SpellingVariant[] | null = null;

function buildLookup(): Map<string, Entry> {
  const map = new Map<string, Entry>();
  FAMILIES.forEach((f, idx) => {
    for (let i = 0; i < f.us.length; i++) {
      const us = f.us[i];
      const uk = f.uk[i];
      if (us === undefined || uk === undefined || us === uk) continue;
      if (!map.has(us)) map.set(us, { family: idx, form: 'us', other: uk, ambiguousUs: f.ambiguousUs === true });
      if (!map.has(uk)) map.set(uk, { family: idx, form: 'uk', other: us, ambiguousUs: f.ambiguousUs === true });
    }
  });
  return map;
}

/** Every (US, UK) pair the engine knows, including inflections. Built on first access. */
export function spellingVariants(): SpellingVariant[] {
  if (variants === null) {
    const out: SpellingVariant[] = [];
    for (const f of FAMILIES) {
      const family = f.us[0] ?? '';
      for (let i = 0; i < f.us.length; i++) {
        const us = f.us[i];
        const uk = f.uk[i];
        if (us !== undefined && uk !== undefined && us !== uk) out.push({ us, uk, family });
      }
    }
    variants = out;
  }
  return variants;
}

const UK_DIALECTS = new Set(['en-gb', 'en-ca', 'en-au', 'en-in']);

/** en-GB, en-CA, en-AU and en-IN expect UK forms; en-US (and anything unknown) expects US forms. Case-insensitive. */
export function expectsUkSpelling(dialect: Dialect): boolean {
  return UK_DIALECTS.has(String(dialect).toLowerCase());
}

const WORD_RE = /\p{L}+/gu;
const ALL_CAPS_RE = /^\p{Lu}{2,}$/u;
/** Lower-case words that link the parts of a name: "Centre for Policy Studies", "Theatre of Dreams". */
const NAME_LINKERS = new Set(['for', 'of', 'the', 'and', 'at', 'on', 'in', 'de', 'du', 'des', 'von', 'van', 'der', 'del', 'da', 'di', 'la', 'le', 'y', 'e']);

/**
 * A capitalized word at a sentence start is a name when the next word is capitalized too ("Harbor Freight is…"),
 * also across a possessive ("Grey's Anatomy is…") or a linking word ("Centre for Policy Studies is…").
 */
function looksLikeName(work: string, end: number): boolean {
  let k = end;
  if ((work.charAt(k) === "'" || work.charAt(k) === '\u2019') && work.charAt(k + 1).toLowerCase() === 's') k += 2;
  if (work.charAt(k) !== ' ' && work.charAt(k) !== '\u00a0') return false;
  k++;
  if (isUpper(work.charAt(k))) return true;
  let j = k;
  while (j < work.length && isLetter(work.charAt(j))) j++;
  return NAME_LINKERS.has(work.slice(k, j)) && work.charAt(j) === ' ' && isUpper(work.charAt(j + 1));
}

/** "math.floor", "colour_value", "colour2", "color()", "color/colour": an identifier or a deliberate contrast, not prose. */
function inIdentifier(work: string, start: number, end: number): boolean {
  const before = start > 0 ? work.charAt(start - 1) : '';
  const after = work.charAt(end);
  if (before === '_' || after === '_' || isDigit(before) || isDigit(after)) return true;
  if (before === '.' && isWordChar(work.charAt(start - 2))) return true;
  if (after === '.' && isWordChar(work.charAt(end + 1))) return true;
  if (after === '(' || after === '=' || after === '/' || after === '\\') return true;
  return before === '/' || before === '\\' || before === '$' || before === '#' || before === '@';
}

export function spellingVariantRule(ctx: RuleContext): void {
  const { work, opts } = ctx;
  if (lookup === null) lookup = buildLookup();
  const expected: 'us' | 'uk' = expectsUkSpelling(opts.dialect) ? 'uk' : 'us';
  const dialectName = expected === 'us' ? 'US' : 'British';
  interface Occ {
    start: number;
    end: number;
    word: string;
    entry: Entry;
    flagged: boolean;
  }
  const occurrences: Occ[] = [];
  for (const m of work.matchAll(WORD_RE)) {
    const word = m[0];
    const lower = word.toLowerCase();
    const entry = lookup.get(lower);
    if (entry === undefined) continue;
    if (ctx.protectedTerms.has(lower)) continue;
    if (ALL_CAPS_RE.test(word)) continue; // acronyms, headings
    const start = m.index;
    const end = start + word.length;
    if (isUpper(word.charAt(0))) {
      if (!ctx.isSentenceStart(start, true)) continue; // proper noun ("the Labour Party", "Pearl Centre")
      if (looksLikeName(work, end)) continue; // "Harbor Freight is…", "Grey's Anatomy is…", "Centre for Policy Studies is…"
    }
    if (work.charAt(end) === '-' || (start > 0 && work.charAt(start - 1) === '-')) continue; // compounds, names
    if (inIdentifier(work, start, end)) continue;
    occurrences.push({ start, end, word, entry, flagged: false });
  }
  if (occurrences.length === 0) return;

  for (const o of occurrences) {
    const { entry } = o;
    if (entry.form === expected) continue;
    if (entry.form === 'us' && entry.ambiguousUs) continue; // "check" may be a verb in a UK text
    o.flagged = true;
    const replacement = matchCase(entry.other, o.word);
    ctx.emit({
      rule: 'consistency_spelling_variant',
      severity: 'warning',
      kind: 'replace',
      start: o.start,
      end: o.end,
      replacement,
      explanation: `"${o.word}" is the ${entry.form === 'us' ? 'US' : 'British'} spelling; ${dialectName} English uses "${replacement}".`,
      confidence: 0.9,
      autoApplySafe: true,
    });
  }

  // Mixed usage inside one family: nudge the minority toward the majority when that agrees with the dialect.
  const byFamily = new Map<number, Occ[]>();
  for (const o of occurrences) {
    const list = byFamily.get(o.entry.family);
    if (list === undefined) byFamily.set(o.entry.family, [o]);
    else list.push(o);
  }
  for (const list of byFamily.values()) {
    const usCount = list.filter((o) => o.entry.form === 'us').length;
    const ukCount = list.length - usCount;
    if (usCount === 0 || ukCount === 0 || usCount === ukCount) continue;
    const majority: 'us' | 'uk' = usCount > ukCount ? 'us' : 'uk';
    if (majority !== expected) continue;
    for (const o of list) {
      if (o.flagged || o.entry.form === majority) continue;
      const replacement = matchCase(o.entry.other, o.word);
      ctx.emit({
        rule: 'consistency_spelling_variant',
        severity: 'suggestion',
        kind: 'replace',
        start: o.start,
        end: o.end,
        replacement,
        explanation: `This document mostly uses "${replacement}"; keep one spelling.`,
        confidence: 0.75,
        autoApplySafe: false,
      });
    }
  }
}
