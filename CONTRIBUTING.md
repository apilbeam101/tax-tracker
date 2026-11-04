# Contributing

Thank you for helping. UK Tax Tracker is a small project, so for anything bigger than a fix or a
clearly scoped improvement, please open an issue first and say what you have in mind. It saves you
writing something that does not fit.

## This repository is public

**Never put real financial data, or anything that identifies you, in an issue, a pull request, a
test, a fixture or a screenshot.** That means no real transactions, holdings, amounts, account
details, passphrases, recovery keys, session secrets or API keys. Use made-up figures and fictional
tickers. If a bug only shows up with particular data, rebuild it with invented numbers that
reproduce it.

## Setting up

You need Node.js 24 or later. The [Development section of the README](README.md#development) has
the steps to clone, build and start the dev server.

## Before you open a pull request

```sh
npm run lint        # Biome: lint and formatting
npm run typecheck
npm test
npm run build
```

CI runs the same checks, plus tests on Linux, macOS and Windows, a package and installer test, an
image build, a dependency audit and CodeQL. Biome decides formatting, so run `npm run format`
rather than arguing with it. Follow the style of the code around your change.

## Things that are easy to get wrong

- **Money is never a JavaScript number.** All monetary arithmetic uses `big.js`, and values are
  stored as text in SQLite.
- **Rates and allowances are data.** CGT rates, the annual exempt amount and the dividend rates
  live in the `tax_year_config` table and are looked up per tax year, because they change every
  year. Do not hard-code them.
- **Tax logic needs a worked example.** A change to share matching, gains, dividends or share
  schemes needs a test with a small made-up scenario, and a note of the HMRC guidance the behaviour
  follows. The expected figures should be calculable by hand.
- **Migrations are append-only.** Add a new numbered file in `src/server/db/migrations/`; never
  edit one that has shipped.
- **Encrypted columns.** `src/server/crypto/fields.ts` classifies every column as encrypted or
  plaintext, and a test fails for a column that is not classified. Only the repository stores read
  or write encrypted columns; never filter or sort on one in SQL.
- **Errors a user can act on** are thrown as the `HttpError` subclasses in `src/server/errors.ts`,
  not as a plain `Error`, which becomes an opaque 500.
- **Installers and deployment files** can be tested only partly on one machine. Say in the pull
  request what you ran and where.

## Pull requests

- Branch from `master` and keep the change focused. A description of why it is needed is more
  useful than a description of what the diff says.
- Add or update tests. A bug fix should come with a test that fails without it.
- For anything a user would notice, add a line under `[Unreleased]` in `CHANGELOG.md` and update
  the relevant page in `docs/`.
- CI must pass before a pull request is merged.

## Reporting problems

Use the issue forms. For anything security-related, follow the [security policy](SECURITY.md)
instead of opening an issue.

## Licence

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE), the
same as the rest of the project.

## For maintainers

How a release is made is in [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md). The design and
the reasons behind it are in [DESIGN.md](DESIGN.md).
