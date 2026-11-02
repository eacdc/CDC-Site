import { readFileSync } from 'node:fs';
import { CONCERN_CATEGORIES, SEVERITIES } from './types.js';

/**
 * The prompts and the text sent with them, shared by every provider. The
 * prompts are Markdown files so they can be tuned without touching code; what
 * lives here is how a group's messages are laid out for the model.
 */

/**
 * One prompt per kind of group. An internal group asks "has something gone
 * wrong on the floor"; a client group asks "has the customer said something we
 * must answer", which is a much lower bar - an unanswered question is itself
 * the problem when a customer is reading the thread.
 *
 * Unknown or missing kind falls back to internal, because the client prompt
 * raises far more and applying it to a plant group by accident would bury
 * someone in alerts.
 */
const DETECTOR_PROMPTS = {
  internal: readFileSync(new URL('../detector/prompt.md', import.meta.url), 'utf8'),
  client: readFileSync(new URL('../detector/client-prompt.md', import.meta.url), 'utf8'),
};

export const promptForKind = (kind) => DETECTOR_PROMPTS[kind] ?? DETECTOR_PROMPTS.internal;
export const SUMMARY_PROMPT = readFileSync(new URL('../summariser/prompt.md', import.meta.url), 'utf8');
export const ROMANISE_PROMPT = readFileSync(new URL('../media/romanise-prompt.md', import.meta.url), 'utf8');
export const RESOLUTION_PROMPT = readFileSync(
  new URL('../detector/resolution-prompt.md', import.meta.url),
  'utf8',
);

export function renderMessages(label, msgs) {
  if (msgs.length === 0) return '';
  // The reply link is what separates a follow-up from a second, unrelated
  // problem reported minutes later, so the model has to be able to see it.
  const lines = msgs.map((m) => {
    const reply = m.replyTo ? ` (reply to [${m.replyTo}])` : '';
    return `[${m.msgId}] ${m.senderName ?? 'unknown'}${reply}: ${m.text.replace(/\n/g, ' ')}`;
  });
  return `${label}\n${lines.join('\n')}\n`;
}

function renderPrevious(previous) {
  if (!previous) return '';
  const section = (label, items) =>
    items?.length ? `${label}\n${items.map((b) => `- ${b}`).join('\n')}\n` : '';
  const body =
    section('Decisions:', previous.decisions) +
    section('Open issues:', previous.openIssues) +
    section('Blocked:', previous.blocked) +
    section('Notable:', previous.notable);
  return body ? `PREVIOUS SUMMARY (carry forward what is still true):\n${body}\n` : '';
}

export function buildSummaryPrompt(input) {
  const lines = input.messages.map(
    (m) => `${m.senderName ?? 'unknown'}: ${m.text.replace(/\n/g, ' ')}`,
  );
  return [
    `Group: ${input.groupName}`,
    `Window: ${input.periodStart.toISOString()} to ${input.periodEnd.toISOString()}`,
    '',
    renderPrevious(input.previous),
    `MESSAGES (${input.messages.length}):`,
    lines.join('\n'),
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildUserPrompt(input) {
  return [
    `Group: ${input.groupName}`,
    '',
    renderMessages('EARLIER MESSAGES (context only — do not raise concerns for these):', input.contextMessages),
    renderMessages('NEW MESSAGES (judge only these):', input.newMessages),
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildResolutionPrompt(input) {
  return [
    `Concern: ${input.summary}`,
    '',
    renderMessages(`THREAD (${input.messages.length} messages, oldest first):`, input.messages),
  ].join('\n');
}

/*
  JSON schemas for providers that can constrain their output to one. They
  mirror the shapes the prompts ask for; the parsers in parse.js still run on
  the result, because a schema can guarantee a field is a string but not that a
  message id is one we actually sent.
*/
const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };

export const CONCERNS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    concerns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageIds: { type: 'array', items: { type: 'string' } },
          category: { type: 'string', enum: CONCERN_CATEGORIES },
          severity: { type: 'string', enum: SEVERITIES },
          summary: { type: 'string' },
          ownerHint: nullableString,
        },
        required: ['messageIds', 'category', 'severity', 'summary', 'ownerHint'],
      },
    },
  },
  required: ['concerns'],
};

const bullets = { type: 'array', items: { type: 'string' } };

export const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { decisions: bullets, openIssues: bullets, blocked: bullets, notable: bullets },
  required: ['decisions', 'openIssues', 'blocked', 'notable'],
};

export const RESOLUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { resolved: { type: 'boolean' }, msgId: nullableString, reason: nullableString },
  required: ['resolved', 'msgId', 'reason'],
};

export const ROMANISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { text: { type: 'string' } },
  required: ['text'],
};
