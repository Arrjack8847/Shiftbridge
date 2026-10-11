/**
 * Fast, conservative message-intent routing.
 *
 * This is a deterministic warning detector, NOT a trained AI model or proof
 * that equipment is actually broken. Unclear messages go to Tencent AI.
 * Keep false positives low: questions, hypothetical events, and resolved
 * incidents must never open issues automatically.
 */
const ACKNOWLEDGMENT = /^(?:hi|hey|hello|good\s+(?:morning|afternoon|evening)|thanks?(?:\s+you)?|thank\s+you|ok(?:ay)?|noted|got\s+it|roger(?:\s+that)?|lol|haha|yes|no|sure|👍|👌|✅)[!.\s]*$/i;
const HYPOTHETICAL = /\b(?:what\s+if|suppose|imagine|hypothetically|in\s+case|if\s+(?:the|a|an|something|anything|it|we|there)\b)\b/i;
const RESOLVED = /\b(?:fixed|repaired|resolved|back\s+online|working\s+again|no\s+longer\s+(?:broken|leaking|down)|used\s+to\s+be\s+broken)\b/i;
const NEGATED = /\b(?:not|isn't|aren't|wasn't|weren't|never|nothing\s+is)\s+(?:actually\s+|even\s+)?(?:broken|damaged|leaking|faulty|offline|down|unsafe|working\s+incorrectly)\b/i;
const INCIDENT_NEGATED = /\b(?:no|not|isn't|aren't|wasn't|weren't|never|without)\s+(?:any\s+)?(?:smoke|sparks|sparking|leaks?|leaking|fire|gas\s+smell|hazard|danger)\b|\bno\s+longer\s+(?:sparking|smoking|leaking|overheating)\b/i;
const INCIDENT = /\b(?:broken|damaged|malfunction(?:ing|ed)?|faulty|leaking|leak|sparking|sparks|overheating|overheated|smoking|smoke|out\s+of\s+order|not\s+working|doesn't\s+work|isn't\s+working|does\s+not\s+work|not\s+responding|won't\s+turn\s+on|cannot\s+turn\s+on|spoilt|spoiled|rosak|won't\s+start|stopped\s+working|stops\s+working|went\s+down|is\s+down|offline|power\s+outage|error\s+code|warning\s+light|unsafe|hazard|hazardous|out\s+of\s+stock|gas\s+smell|gas\s+leak|on\s+fire|water\s+everywhere)\b/i;
const SAFETY = /\b(?:sparking|sparks|overheating|overheated|smoking|smoke|unsafe|hazard|hazardous|gas\s+smell|gas\s+leak|on\s+fire)\b/i;
const INVENTORY = /\b(?:out\s+of\s+stock)\b/i;
const INSTRUCTION = /\b(?:please|can\s+you|could\s+you|assign|ask\s+\w+\s+to|tell\s+\w+\s+to|need\s+(?:someone|\w+)\s+to|must\s+(?:fix|repair|inspect|check|replace))\b/i;


/**
 * Extract only very explicit, low-risk manager assignments.
 * The server independently checks the actual manager, assignee membership,
 * category permissions, and real message before writing a task.
 * Anything complex or involving repairs/safety/spending goes to Tencent.
 */
export function parseFastRoutineTask(body) {
  const text = String(body || '').trim();
  const match = text.match(/^([a-z][a-z'-]{1,24})[,]?[ ]+(?:please[ ]+)?(restock|refill|clean|tidy|organize|count|label|wipe|sweep|sort)[ ]+(.+)$/i);
  if (!match) return null;
  if (/\b(?:if|unless|because|after|when|while|not|never|don't|broken|repair|fix|electrical|danger|hazard|safe|unsafe|purchase|buy|pay|refund|replace|inspect|certify|approve|cash|money|register|payment|bank|salary|invoice|chemical|fire|gas|oven|machine|electrical|equipment|emergency|hazardous)\b/i.test(text)) return null;

  const assignee = match[1].toLowerCase();
  const verb = match[2].toLowerCase();
  let object = match[3].trim().replace(/[.!]+$/, '').trim();
  let due = 'Today';
  const dueMatch = object.match(/\s+(before|by)\s+([^,;!?]+)$/i);
  if (dueMatch) {
    due = `${dueMatch[1][0].toUpperCase()}${dueMatch[1].slice(1).toLowerCase()} ${dueMatch[2].trim()}`;
    object = object.slice(0, dueMatch.index).trim();
  }

  if (!object || object.length > 90 ||
      /[?;:]/.test(object) || /\b(?:and|or|also|then)\b/i.test(object) ||
      !/^[\w\s'-]+$/i.test(object)) return null;

  const category = ['restock', 'refill', 'count', 'label', 'sort'].includes(verb)
    ? 'inventory'
    : ['clean', 'wipe', 'sweep', 'tidy'].includes(verb) ? 'cleaning'
      : verb === 'prepare' ? 'opening' : 'routine';

  return {
    assignee,
    name: `${verb[0].toUpperCase()}${verb.slice(1)} ${object}`,
    due,
    category,
    priority: 'normal',
  };
}

export function classifyIncomingMessage(body) {
  const text = String(body || '').trim().replace(/[\u2018\u2019]/g, "'");
  if (!text || ACKNOWLEDGMENT.test(text)) {
    return { route: 'skip', reason: 'acknowledgment-or-empty' };
  }

  // A question may be an information request, not a report of an active fault.
  // Never create a warning for a conditional, negated, or resolved statement.
  if (/^(?:i(?:'m| am)|we(?:'re| are)|you(?:'re| are))\s+(?:so\s+)?broken\b/i.test(text)) {
    return { route: 'ai', reason: 'personal-metaphor' };
  }
  if (HYPOTHETICAL.test(text) || RESOLVED.test(text) || NEGATED.test(text) || INCIDENT_NEGATED.test(text) ||
      text.endsWith('?') || /\bbroken\s+heart\b/i.test(text)) {
    return { route: 'ai', reason: 'requires-context' };
  }

  if (!INCIDENT.test(text)) {
    const task = parseFastRoutineTask(text);
    if (task) return { route: 'routine-task', task, reason: 'explicit-low-risk-assignment' };
    return { route: 'ai', reason: 'no-certain-warning' };
  }

  const issueType = SAFETY.test(text) ? 'safety' : INVENTORY.test(text) ? 'inventory' : 'equipment';
  return {
    route: 'issue',
    issueType,
    severity: issueType === 'safety' ? 'high' : 'normal',
    // A warning and an explicit instruction may require a protected task proposal.
    // Keep Tencent in the loop, but report the warning immediately.
    needsAi: INSTRUCTION.test(text),
    reason: 'explicit-present-incident',
  };
}
