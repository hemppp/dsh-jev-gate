# `client/` — the browser half of `dsh-jev-gate`

`client/index.js` is the **only** browser module this package ships. It is plain
ES2022 JavaScript, loaded through the host module loader exactly like the other
client plugins:

```js
window.__ModuleLoader__.load({
  id: 'dsh-jev-gate',
  factory: (require) => { /* ... */ },
})
```

It requires just two host modules — `react/jsx-runtime` (`{ jsx, jsxs }`) and
`@deepseek-ai/dsh-client-ui-primitives` — and never imports the host half, so the
browser bundle carries no Node-only code.

## What it renders

One configuration panel, registered into the slot **`plugins.row.config`** under
the key **`dsh-jev-gate#dsh-jev-gate`** (`<package name>#<cordis row id>`; both are
`dsh-jev-gate`). The panel is registered only while the host actually serves the
settings namespace `dsh-jev-gate`, so a deployment that does not configure this
plugin never grows an empty page.

Required services (`inject`):
`['slots', 'locale', 'remote', 'remote.credentials', 'configForms']`.

## Fields

Every field is **flat and top-level**. The host's `SettingsFormModel` hands a field
name to settings as a single-segment path (`path: [field]`), so a nested name such
as `decider.baseUrl` cannot be written — the host answers
`Config field "decider.baseUrl" is not volatile`. That is why `host/config.ts`
flattens the decider settings, and why the per-decision-point rule overrides travel
as one JSON string (`rulesJson`) instead of a nested array.

`FIELDS` mirrors the fields marked `.volatile()` in `host/config.ts` exactly, in
declaration order — 22 of them:

| kind | fields |
| --- | --- |
| boolean (`SwitchRow`) | `enabled`, `persistEnabled`, `interveneAtStateTransition`, `interveneAtPreFinish`, `requireBaseline` |
| enum (`<select>`) | `mode`, `onUnavailable`, `roleAwareness`, `narrativeWatch`, `deciderKind`, `deciderAuthority` |
| number (`settingsNumberField`) | `minConfidence`, `maxGapsPerIntervention`, `debounceMs`, `deciderMaxQuestions` |
| text (`settingsTextField`) | `stateDir`, `deciderProvider`, `deciderModel`, `deciderBaseUrl`, `deciderEndpointPath`, `deciderCredentialRef`, `rulesJson` |

A field missing from this page is a knob nobody can change; a field that is here but
not volatile on the host is a save the host will always reject.
`scripts/run-contract-check.mjs` computes the volatile set from the host schema and
compares it against the exported `FIELDS`, so the two sides cannot drift apart
silently.

## Secrets

The API key input is **not** a config field and never reaches the settings file or
any response. On save the panel calls
`ctx.remote.credentials.set(<reference>, <value>)`, where `<reference>` is the
current value of the `deciderCredentialRef` field, and reads back only
`describe([ref]) → { configured, writable? }`. The plaintext is never returned to
any page — that is the credential service's own guarantee, not a choice here.

`apiKey` is local-only form state with a custom writer; a save therefore does two
things at once: it writes configuration into settings, and it writes the secret
into the credential service.

## Rule overrides

`rulesJson` is an opaque string to the form, so the panel renders the read-only
`DECISION_POINTS` table beneath it: the built-in decision-point ids and their
default ceiling (the strongest rung a hard contradiction there may reach). The
table is a copy of `DECISION_POINTS` in `host/catalog.ts` and is exported so the
contract check fails the build if it drifts. The ids are language-neutral, so only
the column heading is translated.

An override may only ever *lower* force, never raise it:

```json
[{ "pointId": "review_verdict", "ceiling": "L2_continue" }]
```

## Exports (from the factory)

`NS`, `ENTRY_NS`, `ROW_KEY`, `SLOT`, `FIELDS`, `DECISION_POINTS`, `SECRET_FIELDS`,
`REF_FIELD`, `MODE_OPTIONS`, `KIND_OPTIONS`, `AUTHORITY_OPTIONS`,
`UNAVAILABLE_OPTIONS`, `ROLE_AWARENESS_OPTIONS`, `NARRATIVE_OPTIONS`, `apply`,
`inject`.

Two of them exist for the contract check rather than for the UI:

- `FIELDS` — compared against the host schema's volatile field set.
- `DECISION_POINTS` — an id → default-ceiling map, compared against `host/catalog.ts`.

`SECRET_FIELDS` names the local-only secret inputs; they are deliberately absent
from `FIELDS`.

## Dictionaries

A single dictionary namespace, `dsh-jev-gate.settings`, with complete `zh` and `en`
tables. Every label and hint key the component reads must exist in **both** — a
missing key renders as the raw key name, which is a user-visible defect. The key
naming is mechanical: a field's label key is the field name, its hint key is the
field name plus `Hint`.
