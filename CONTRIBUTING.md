# Contributing to Exo

Thanks for your interest in contributing to Exo! This document covers the expectations and workflow for getting a PR merged.

## Prerequisites

- [Claude Code](https://claude.ai/claude-code) with [gstack](https://github.com/anthropics/gstack) installed
- Node.js and npm
- A working dev environment (see [Getting Started](./CLAUDE.md#commands))

## Development Workflow

All contributions should use **gstack** (Claude Code with the gstack skill set) as the primary development tool. This ensures consistent quality, thorough review, and proper testing before code reaches the main branch.

### 1. Plan and Review

Before writing code, create a plan and run the engineering review:

```
/plan-eng-review
```

This will walk through your architecture, data flow, edge cases, and test coverage. Address any issues it raises before proceeding to implementation.

### 2. Implement

Write your code following the standards in [CLAUDE.md](./CLAUDE.md#coding-standards). 

### 3. QA Test

Run the QA skill against your changes:

```
/qa
```

This systematically tests the application, finds bugs, and fixes them. All issues found should be resolved before opening a PR.

### 4. Pre-PR Checks

Before opening a PR, ensure all checks pass:

```bash
npx tsc --noEmit        # Type check
npm test                 # Unit + e2e + integration tests
```

### 5. Code Review

Run the review skill on your diff:

```
/review
```

This analyzes your changes for SQL safety, trust boundary violations, structural issues, and other problems. Fix anything it flags before opening the PR.

### 6. Open the PR

Once all of the above pass, open your pull request. Automated review bots will also run — address any issues they raise.

### 7. Satisfy the review bots

You can use the `/reviewloop` skill to help you out here.

## What We Look For

- **Correctness over cleverness** — code that works but is hard to understand is not acceptable
- **Simplicity** — use library features when available, don't reinvent solved problems
- **Tests that matter** — don't write tests just to have tests. Think about which tests are valuable
- **No flaky tests** — a single test failure is a real failure, not flakiness

## Questions?

If something is unclear, open an issue or ask in the PR. We'd rather answer questions upfront than review code that went in the wrong direction.
