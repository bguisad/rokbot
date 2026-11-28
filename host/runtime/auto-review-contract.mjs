// The contract of the shipped classifier tool, CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL (2bb5e41
// host-library.cjs, packages/agent/dist/sand-auto-review/sand-auto-review-classifier.js), and of
// SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT, which tells the model how to fill it in. The live
// schema still comes from the library at runtime; these constants are what the rules below were
// written against, so a library whose schema no longer matches can be reported (contractDrift).
//
// Each rule cites the text it comes from: [field] is that property's schema description,
// [prompt] the classifier system prompt.

export const TOOL_NAME = 'classify_auto_review_action';
export const DECISIONS = Object.freeze(['ALLOW', 'BLOCK']);
export const BLOCKED_EFFECTS = Object.freeze(['none', 'outbound_or_binding_external_effect', 'data_or_credential_exfiltration',
  'destructive_data_loss', 'host_compromise_or_persistence', 'trusted_block_instruction']);
export const OUTBOUND_AUTHORIZATIONS = Object.freeze(['not_outbound', 'trusted_destination', 'unauthorized_destination']);
/** Effects (1) and (2): the ones that need who_sees_it and an outbound_authorization. */
export const OUTBOUND_EFFECTS = Object.freeze(['outbound_or_binding_external_effect', 'data_or_credential_exfiltration']);
export const REQUIRED = Object.freeze(['decision', 'reason', 'blocked_effect', 'outbound_authorization', 'action_description']);
/** SAND_AUTO_REVIEW_PROPOSE_ALLOW_RULE_PURPOSE: a target asking for a rule whatever the decision. */
export const PROPOSE_ALLOW_RULE_PURPOSE = 'propose_allow_rule';
/** SmartModeClassifierRuleEffect / SmartModeClassifierRuleSource values. */
export const RULE_EFFECT = Object.freeze({ ALLOW: 1, ASK_FIRST: 2 });
export const RULE_SOURCE = Object.freeze({ CUSTOM_RULE: 1 });

const string = { type: 'string' };
/** The shipped parameters without their (long) descriptions: names, types, enums, required. */
export const SHIPPED_PARAMETERS = Object.freeze({
  type: 'object',
  properties: {
    blocked_effect: { ...string, enum: [...BLOCKED_EFFECTS] },
    who_sees_it: string,
    outbound_authorization: { ...string, enum: [...OUTBOUND_AUTHORIZATIONS] },
    reason: string,
    action_description: string,
    decision: { ...string, enum: [...DECISIONS] },
    proposed_allow_rule: string,
    proposed_allow_rule_replaces: string,
    matched_block_instruction: string,
    matched_allow_instruction: string,
  },
  required: [...REQUIRED],
});

/** Where a library's schema differs from the one these rules follow; empty when it matches. */
export function contractDrift(parameters) {
  const drift = [];
  const properties = parameters?.properties ?? {};
  const required = new Set(parameters?.required ?? []);
  for (const name of REQUIRED) if (!required.has(name)) drift.push(`${name} is no longer required`);
  for (const name of required) if (!REQUIRED.includes(name)) drift.push(`${name} is newly required`);
  for (const [name, expected] of Object.entries(SHIPPED_PARAMETERS.properties)) {
    const actual = properties[name];
    if (!actual) { drift.push(`${name} is missing`); continue; }
    if (actual.type !== expected.type) drift.push(`${name} is ${actual.type}`);
    if (expected.enum && JSON.stringify([...(actual.enum ?? [])].sort()) !== JSON.stringify([...expected.enum].sort()))
      drift.push(`${name} enum is ${JSON.stringify(actual.enum ?? null)}`);
  }
  for (const name of Object.keys(properties)) if (!SHIPPED_PARAMETERS.properties[name]) drift.push(`${name} is new`);
  return drift;
}

/** The model answered, but not with a classification that can be used; worth one more attempt. */
export class ReviewOutputError extends Error {}

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const words = value => value.split(/\s+/).filter(Boolean);
/** Every word of `entry`, unchanged and in order, appears in `rule` ([proposed_allow_rule_replaces]). */
function keepsEveryWord(rule, entry) {
  const ruleWords = words(rule);
  let at = 0;
  for (const word of words(entry)) {
    at = ruleWords.indexOf(word, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}
const policyList = (policy, key) => (Array.isArray(policy?.[key]) ? policy[key] : [])
  .filter(entry => typeof entry === 'string').map(entry => entry.trim()).filter(Boolean);

/**
 * Reads one tool call against the shipped contract.
 * - Throws ReviewOutputError when the answer cannot be acted on safely (worth a retry).
 * - Otherwise returns the verdict to hand to the runner, plus `notes` on what was off-contract but
 *   harmless and was ignored, dropped or downgraded.
 * `schema` is the library's live parameters (its required list and enums are checked as given);
 * `target` is the reviewed SmartModeRiskTarget as JSON (purpose, project_permissions).
 */
export function readClassification(raw, schema, target) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReviewOutputError('The classification is not a JSON object');
  const notes = [];
  const properties = schema?.properties ?? {};
  const inEnum = (name, value) => !properties[name]?.enum || properties[name].enum.includes(value);
  const valid = name => typeof raw[name] === 'string' && inEnum(name, raw[name]);

  // [decision] enum ALLOW | BLOCK: the one field every outcome depends on.
  if (!valid('decision') || !DECISIONS.includes(raw.decision))
    throw new ReviewOutputError(`decision must be one of ${DECISIONS.join(', ')}`);
  const policy = target?.arguments?.project_permissions?.auto_run;
  const proposing = target?.arguments?.purpose === PROPOSE_ALLOW_RULE_PURPOSE;
  for (const name of schema?.required ?? []) {
    if (typeof raw[name] !== 'string') notes.push(`${name} is missing`);
    else if (!inEnum(name, raw[name])) notes.push(`${name} "${raw[name]}" is not allowed`);
  }

  let decision = raw.decision;
  const effect = valid('blocked_effect') ? raw.blocked_effect : undefined;
  const authorization = valid('outbound_authorization') ? raw.outbound_authorization : undefined;
  if (decision === 'BLOCK') {
    // [blocked_effect] "Always required ... Which BLOCK prerequisite this exact call satisfies";
    // [outbound_authorization] "Always required". A BLOCK without them cannot be weighed.
    if (!effect) throw new ReviewOutputError(`A BLOCK needs blocked_effect, one of ${BLOCKED_EFFECTS.join(', ')}`);
    if (!authorization) throw new ReviewOutputError(`A BLOCK needs outbound_authorization, one of ${OUTBOUND_AUTHORIZATIONS.join(', ')}`);
    const outbound = OUTBOUND_EFFECTS.includes(effect);
    // [prompt] "A BLOCK that names no prerequisite, or that names (1) or (2) with trusted_destination /
    // missing who_sees_it ... is treated as ALLOW"; [decision] "Must be ALLOW when blocked_effect is
    // 'none' or outbound_authorization is trusted_destination."
    const downgrade = effect === 'none' ? 'blocked_effect is none'
      : outbound && authorization === 'trusted_destination' ? 'its destination is trusted_destination'
        : outbound && authorization === 'unauthorized_destination' && !text(raw.who_sees_it) ? 'who_sees_it is missing'
          : undefined;
    if (downgrade) {
      notes.push(`BLOCK treated as ALLOW: ${downgrade}`);
      decision = 'ALLOW';
    } else if (outbound) {
      // [outbound_authorization] "BLOCK with outbound_or_binding_external_effect or
      // data_or_credential_exfiltration only when this is unauthorized_destination." not_outbound
      // contradicts the effect itself; the prompt does not say how to read it, so ask again.
      if (authorization !== 'unauthorized_destination')
        throw new ReviewOutputError(`blocked_effect ${effect} needs outbound_authorization unauthorized_destination or trusted_destination, not ${authorization}`);
    } else if (authorization === 'trusted_destination') {
      // [outbound_authorization] "not_outbound when blocked_effect is neither ..." while [decision]
      // says trusted_destination means ALLOW: contradictory for a destructive/host/rule BLOCK.
      throw new ReviewOutputError(`blocked_effect ${effect} is not outbound, so outbound_authorization must be not_outbound`);
    }
  }

  const verdict = { decision, appliedRules: [] };
  // [matched_allow_instruction] "Set, whatever the decision, when one ... allow_instructions entry
  // covers this call ... Copy that one entry character for character." Only a saved entry counts:
  // the runner uses it to honour the user's own Allow rule (ownerAllowRuleCoversSend).
  const allowRule = text(raw.matched_allow_instruction);
  if (allowRule && policyList(policy, 'allow_instructions').includes(allowRule))
    verdict.appliedRules.push({ effect: RULE_EFFECT.ALLOW, source: RULE_SOURCE.CUSTOM_RULE, text: allowRule });
  else if (allowRule) notes.push('matched_allow_instruction is not a saved Allow rule; dropped');

  if (decision === 'BLOCK') {
    // [reason] "For BLOCK: one or two short non-empty user-facing sentences". Without one the runner
    // shows its own "Blocked by Auto-review", which is still a usable card.
    const reason = text(raw.reason);
    if (reason) verdict.blockReason = reason.slice(0, 500);
    else notes.push('a BLOCK reason is empty');
    // [action_description] "On BLOCK ...: one short sentence" — shown on the card; optional there.
    const description = text(raw.action_description);
    if (description) verdict.actionDescription = description.slice(0, 500);
    else notes.push('a BLOCK action_description is empty');
    verdict.blockedEffect = effect;
    if (effect === 'trusted_block_instruction') {
      // [matched_block_instruction] "Required when blocked_effect is trusted_block_instruction ... Copy
      // the one ... block_instructions entry that matched".
      const blockRule = text(raw.matched_block_instruction);
      if (blockRule && policyList(policy, 'block_instructions').includes(blockRule))
        verdict.appliedRules.push({ effect: RULE_EFFECT.ASK_FIRST, source: RULE_SOURCE.CUSTOM_RULE, text: blockRule });
      else notes.push(blockRule ? 'matched_block_instruction is not a saved Ask first rule; dropped' : 'matched_block_instruction is missing');
    }
  } else if (text(raw.action_description)) {
    notes.push('an ALLOW action_description is not empty; ignored'); // [action_description] "On ALLOW, an empty string."
  }

  // [proposed_allow_rule] "Required on BLOCK EXCEPT when blocked_effect is trusted_block_instruction —
  // omit it there and on ALLOW, unless the call's arguments carry purpose "propose_allow_rule",
  // which requires it whatever the decision."
  const wantsRule = proposing || (decision === 'BLOCK' && effect !== 'trusted_block_instruction');
  const rule = text(raw.proposed_allow_rule);
  if (rule && wantsRule) verdict.proposedAllowRule = rule.slice(0, 500);
  else if (rule) notes.push('proposed_allow_rule is not wanted here; dropped');
  else if (wantsRule) notes.push('proposed_allow_rule is missing');
  // [proposed_allow_rule_replaces] "Set only with proposed_allow_rule, when it extends one
  // allow_instructions entry ... Copy that entry character for character. proposed_allow_rule must
  // then keep every word of that entry unchanged and in order and only add words".
  const replaces = text(raw.proposed_allow_rule_replaces);
  if (replaces && verdict.proposedAllowRule) {
    if (policyList(policy, 'allow_instructions').includes(replaces) && keepsEveryWord(verdict.proposedAllowRule, replaces))
      verdict.proposedAllowRuleReplaces = replaces;
    else notes.push('proposed_allow_rule_replaces does not name a saved Allow rule the proposal extends; dropped');
  }
  return { verdict, notes };
}
