const WRAPPER_RE = /^\s*<(?:cross-session-message|task-notification|system-reminder|scheduled-tasks?|local-command-[a-z]+|command-stdout|user-prompt-submit-hook|bash-(?:stdout|stderr|input)|teammate-message|channel)\b/i;
const INJECTED_MARKERS = ['<cross-session-message', '<task-notification'];
const INJECTED_PREFIXES = ['Caveat:', '[Request interrupted'];

export function isHumanPrompt(entry) {
  if (!entry || typeof entry !== 'object' || entry.type !== 'user') return false;
  if (entry.isSidechain || entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly) return false;
  if (entry.toolUseResult !== undefined || entry.sourceToolUseID || entry.sourceToolAssistantUUID) return false;
  if (entry.userType && entry.userType !== 'external') return false;
  const content = entry.message && entry.message.content;
  const texts = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') return false;
      if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  } else return false;
  if (texts.some((t) => INJECTED_MARKERS.some((m) => t.includes(m)))) return false;
  return texts.some((t) => {
    const s = t.trim();
    return s.length > 0 && !WRAPPER_RE.test(s) && !INJECTED_PREFIXES.some((p) => s.startsWith(p));
  });
}
