// The same for the OpenCode 2 program: no Claude at all, the OpenCode 2 program (the fake) does
// the editing. See ../no-claude.mjs.
import { noClaudeScenario } from "../no-claude.mjs";

export default noClaudeScenario({
  name: "no-claude-opencode2",
  title: "No Claude at all: choose the OpenCode 2 program, key, model, and an edit completes",
  skip: null,
});
