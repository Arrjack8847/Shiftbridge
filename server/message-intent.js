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
const INCIDENT = /\b(?:broken|damaged|malfunction(?:ing|ed)?|faulty|leaking|leak|sparking|sparks|overheating|overheated|smoking|smoke|out\s+of\s+order|not\s+working|doesn't\s+work|won't\s+start|stopped\s+working|stops\s+working|went\s+down|is\s+down|offline|power\s+outage|error\s+code|warning\s+light|unsafe|hazard|hazardous|out\s+of\s+stock|gas\s+smell|gas\s+leak|on\s+fire|water\s+everywhere)\b/i;
const SAFETY = /\b(?:sparking|sparks|overheating|overheated|smoking|smoke|unsafe|hazard|hazardous|gas\s+smell|gas\s+leak|on\s+fire)\b/i;
const INVENTORY = /\b(?:out\s+of\s+stock)\b/i;
const INSTRUCTION = /\b(?:please|can\s+you|could\s+you|assign|ask\s+\w+\s+to|tell\s+\w+\s+to|need\s+(?:someone|\w+)\s+to|must\s+(?:fix|repair|inspect|check|replace))\b/i;

export function classifyIncomingMessage(body) {
  const text = String(body || '').trim().replace(/[\u2018\u2019]/g, "'");
  if (!text || ACKNOWLEDGMENT.test(text)) {
    return { route: 'skip', reason: 'acknowledgment-or-empty' };
  }

  // A question may be an information request, not a report of an active fault.
  // Never create a warning for a conditional, negated, or resolved statement.
  if (HYPOTHETICAL.test(text) || RESOLVED.test(text) || NEGATED.test(text) ||
      text.endsWith('?') || /\bbroken\s+heart\b/i.test(text)) {
    return { route: 'ai', reason: 'requires-context' };
  }

  if (!INCIDENT.test(text)) {
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
