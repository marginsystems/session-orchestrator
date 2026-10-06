import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isHumanPrompt } from '../lib/prompts.mjs';

const line = (o) => ({ type: 'user', userType: 'external', timestamp: new Date().toISOString(), ...o });
const cases = [
    ['typed string', line({ message: { role: 'user', content: 'please add a retry to the fetch helper' } }), true],
    ['typed text block', line({ message: { role: 'user', content: [{ type: 'text', text: 'ship it' }] } }), true],
    ['typed text after a system reminder block', line({ message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>be brief</system-reminder>' }, { type: 'text', text: 'what is next?' }] } }), true],
    ['typed slash-free question with angle bracket', line({ message: { role: 'user', content: 'is a < b true here?' } }), true],
    ['tool result', line({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, toolUseResult: { stdout: 'ok' } }), false],
    ['tool result block only', line({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }), false],
    ['cross-session message', line({ message: { role: 'user', content: '<cross-session-message from-session="local_x">hello</cross-session-message>' } }), false],
    ['cross-session message in a block', line({ message: { role: 'user', content: [{ type: 'text', text: '<cross-session-message from-session="local_x">hi</cross-session-message>' }] } }), false],
    ['task notification', line({ message: { role: 'user', content: '<task-notification><task-id>1</task-id></task-notification>' } }), false],
    ['system reminder only', line({ message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }] } }), false],
    ['scheduled task wrapper', line({ message: { role: 'user', content: '<scheduled-task name="nightly">run the report</scheduled-task>' } }), false],
    ['local command output', line({ message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' } }), false],
    ['meta entry', line({ isMeta: true, message: { role: 'user', content: 'Caveat: generated' } }), false],
    ['sidechain entry', line({ isSidechain: true, message: { role: 'user', content: 'subagent prompt' } }), false],
    ['compact summary', line({ isCompactSummary: true, message: { role: 'user', content: 'summary of the conversation' } }), false],
    ['interrupt marker', line({ message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }), false],
    ['assistant entry', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, false],
    ['empty text', line({ message: { role: 'user', content: '   ' } }), false],
    ['non-external user type', line({ userType: 'internal', message: { role: 'user', content: 'injected' } }), false],
    ['garbage', null, false],
];

for (const [name, entry, expected] of cases) {
  test(`isHumanPrompt: ${name}`, () => {
    assert.equal(isHumanPrompt(entry), expected);
  });
}
