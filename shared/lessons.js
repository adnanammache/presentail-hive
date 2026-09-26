// Limits on agents' lessons, shared by the server and the Lessons tab.
export const LESSON_LIMITS = {
  // Every lesson goes into every prompt. Past this many, the Lessons tab asks you to prune.
  SOFT_CAP: 25,
  // Never more than this many in a prompt (the newest). The Lessons tab says when some are left out.
  MAX_IN_PROMPT: 40,
  // Lessons an agent proposes must be short and specific. People can write up to HUMAN_MAX_CHARS.
  AGENT_MAX_CHARS: 300,
  HUMAN_MAX_CHARS: 1000,
};
