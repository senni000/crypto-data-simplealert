# Repository Guidelines
返信する時は日本語でやり取りをしてください。

## Project Structure & Module Organization
Source code lives in `src/`, with domain models under `src/models`, data flows and integrations in `src/services`, shared helpers in `src/utils`, and shared types in `src/types`. Service-level unit tests reside beside their targets within `src/services/__tests__`. Build artifacts compile to `dist/`; never edit generated files directly. Sample workflows or one-off scripts can sit in `collect-data/` or `simple-alert/`, but production code should stay in `src/`. Environment templates are managed through `.env.example`.

## Build, Test, and Development Commands
Use `npm install` once per environment to sync dependencies. `npm run build` emits TypeScript to `dist/` and must succeed before releasing changes. `npm start` executes the compiled bundle; `npm run dev` runs the TypeScript entry point via `ts-node` for rapid iteration. Run `npm test` (or `npm test -- --watch`) to execute the Jest suite, and `npm run clean` to remove stale build output.

## Coding Style & Naming Conventions
Write TypeScript with the compiler’s strict mode satisfied; fix all `tsc` diagnostics before review. Prefer 2-space indentation, `camelCase` for functions and variables, `PascalCase` for classes/interfaces, and `UPPER_SNAKE_CASE` for environment keys. Keep modules focused, exposing explicit exports from `src/index.ts` or feature entry files. When touching services, add concise comments only where business rules are non-obvious.

## Testing Guidelines
Jest drives the test suite (`jest.config.js`); tests load from `src/**/__tests__` or `*.test.ts`. Mirror the production module name in each test file (e.g., `data-collector.test.ts`). Maintain useful `describe` blocks so failure output is actionable. Aim to keep coverage reports clean—Jest writes them to `coverage/`. Any new integration with Deribit or Discord should include mocks to avoid network calls.

## Commit & Pull Request Guidelines
Write commits in the imperative mood under 72 characters (e.g., `Add Deribit heartbeat watchdog`). Group related changes together and document any schema updates or env additions in the commit body. Pull requests should summarize intent, list verification steps (`npm run build`, `npm test`), reference tracked issues, and attach screenshots or logs for alert changes. Confirm secrets remain out of the diff before requesting review.

## Environment & Security Tips
Base configuration on `.env.example`; never commit real secrets. Validate `DISCORD_WEBHOOK_URL` and `DATABASE_PATH` locally before deploying. SQLite files should live outside source control (update `.gitignore` if needed). Rotate webhook URLs after testing external integrations, and scrub logs before sharing them in tickets.
