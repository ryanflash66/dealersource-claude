# dealersource-claude

Independent implementation of the **dealersource** task, produced by **Claude Code (Anthropic)**.

| | |
|---|---|
| Agent | Claude Code (Anthropic) |
| Owner | @ryanflash66 |
| Parent (orchestration) repo | https://github.com/ryanflash66/dealersource |
| Mounted in parent at | `agents/claude-solution` |

## Purpose

This repo holds one agent's complete, standalone solution. It is one of several
sibling repos that receive the same task spec from the parent repo so their
results can be compared side by side.

## Rules

- This repo is fully independent: it has its own history, tooling, tests, and CI.
- Do **not** reference sibling agent repos. Only the parent repo knows about siblings.
- The task spec and prompts live in the parent repo under `prompts/`.
  Read them from there; do not copy them into this repo.
- Evaluation results are recorded in the parent repo under `results/`,
  not here.

## Layout

Application code goes here, structured however the agent prefers.
Keep a `README.md` (this file) explaining how to run and test the solution.
