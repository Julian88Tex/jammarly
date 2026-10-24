/**
 * `tense`: a finished action told in the past progressive ("Priya and I were looking at venues yesterday") reads
 * better in the simple past ("looked"), the way Grammarly words it. Only when the sentence pins the action to a
 * finished time ("yesterday", "last week", "two days ago") and nothing marks it as background to another event
 * ("when", "while", "all day"), and only for verbs with a known past form.
 */
import type { RuleContext } from './context';
import type { Token } from './tokens';
import { casePreserve, inQuotes, nextSpaced, tokensOf } from './tokens';
import { dict } from './dict';

const PAST = dict<string>({
  looking: 'looked', working: 'worked', talking: 'talked', thinking: 'thought', planning: 'planned', trying: 'tried',
  waiting: 'waited', checking: 'checked', meeting: 'met', discussing: 'discussed', reviewing: 'reviewed', going: 'went',
  doing: 'did', making: 'made', getting: 'got', reading: 'read', writing: 'wrote', calling: 'called',
  visiting: 'visited', chatting: 'chatted', testing: 'tested', preparing: 'prepared', finishing: 'finished',
  emailing: 'emailed', speaking: 'spoke', watching: 'watched', searching: 'searched', comparing: 'compared',
  exploring: 'explored', touring: 'toured', researching: 'researched', considering: 'considered', asking: 'asked',
  helping: 'helped', building: 'built', drafting: 'drafted', editing: 'edited', updating: 'updated',
});

const FINISHED_TIME =
  /\b(?:yesterday|last (?:night|week|weekend|month|year|quarter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:\d+|a|one|two|three|few|a few|several) (?:days?|weeks?|months?|years?) ago)\b/i;
/** Background readings, where the progressive is right: "we were looking at venues when the call came". */
const BACKGROUND = /\b(?:when|while|as soon as|until|all (?:day|morning|afternoon|evening|night|week)|the whole|still|always|for hours)\b/i;

function sentenceBounds(text: string, start: number, end: number): [number, number] {
  let s = start;
  while (s > 0 && !/[.!?\n]/.test(text.charAt(s - 1))) s--;
  let e = end;
  while (e < text.length && !/[.!?\n]/.test(text.charAt(e))) e++;
  return [s, e];
}

export function tenseRule(ctx: RuleContext): void {
  if (ctx.opts.context === 'code') return;
  const ts = tokensOf(ctx);
  const list = ts.list;
  for (let i = 0; i + 1 < list.length; i++) {
    const aux = list[i] as Token;
    if (aux.norm !== 'was' && aux.norm !== 'were') continue;
    const verb = nextSpaced(ts, i);
    if (verb === undefined || verb.text !== verb.norm) continue;
    const past = PAST.get(verb.norm);
    if (past === undefined) continue;
    const [s, e] = sentenceBounds(ctx.text, aux.start, verb.end);
    const sentence = ctx.text.slice(s, e);
    if (!FINISHED_TIME.test(sentence) || BACKGROUND.test(sentence)) continue;
    if (inQuotes(ts, aux.start, verb.end)) continue;
    ctx.emit({
      rule: 'tense',
      severity: 'suggestion',
      kind: 'replace',
      start: aux.start,
      end: verb.end,
      replacement: casePreserve(past, aux.text),
      explanation: `The action is finished, so the simple past "${past}" reads better than "${aux.text} ${verb.text}".`,
      confidence: 0.7,
      autoApplySafe: false,
      alternatives: [],
    });
    i++;
  }
}
