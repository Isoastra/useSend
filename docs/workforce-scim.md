# Workforce identities

`/scim/v2` implements the Grid `@isoastra/fleet-scim` contract pinned in
`apps/web/vendor/provenance.json`. Discovery lists the supported SCIM capabilities.
Users use immutable JSON `[issuer, subject]` external IDs. Groups map only
`workforce:<WORKFORCE_SCIM_SCOPE>:self` to `workforce-self` on that exact scope.
Unknown roles/resources are rejected; workforce users receive no team, email,
campaign, API-key, billing, or administrator access.

Provisioning creates a native User, OIDC Account and retained `usesend_workforce`
record. Native binding keys and users cannot be reassigned or deleted through
SCIM. Existing account subjects and email collisions return 409 rather than
adopting existing customer identities. The native foreign key protects the OIDC
binding. Email/name changes are controller-owned and update the native profile.

OIDC sign-in requires an existing provider subject. Workforce sign-in additionally
requires the configured trusted issuer and current active self grant. Unknown,
inactive, unassigned and alternate-provider workforce sign-ins are denied before
JIT account/team admission. OIDC email auto-linking is disabled. Previously bound
owner/support accounts retain their existing product access. Customer login
providers and service-owned team API keys retain their existing behavior.

Workforce sessions use the real NextAuth adapter. Minting and SCIM revocation lock
the same native User row; every session read rechecks native activity/grants.
Group removal or deactivation atomically deletes native sessions, clears native
OIDC tokens, and persists the revocation epoch in the same PostgreSQL transaction.
Any mint that wins before revocation is removed; a subsequent mint is denied.
Workforce cannot issue delegated/team API credentials, so revocation confirmation
does not claim to delete existing customer or service-owned API keys.

Self access is `/api/workforce/me`; `/api/workforce/entry` directs workforce there
and existing product users to their dashboard. Product session/TRPC procedures
deny workforce users. No product administrator flag or team membership is granted.

## Deployment

Build the `isoastra-deployed` release branch with its vendored package available in
both Turbo's source context and the installer context. Run Prisma migration deploy
once with the migration owner before rolling the app. The additive migration
models the native table in Prisma and places shared provider metadata in `fleet`
to keep it outside public-schema convergence. Backups must include `fleet`, public
native workforce rows, and the migration journal together.

Configure `OIDC_ISSUER`, `WORKFORCE_SCIM_SCOPE`, `WORKFORCE_SCIM_BASE_URL` (public
origin plus `/scim/v2`), and independent long random `WORKFORCE_SCIM_TOKEN` and
`WORKFORCE_SCIM_READ_TOKEN`. The latter permits authenticated reads only. Store
credentials in the existing encrypted custody/env route; never distribute passwords
to application users. Scope absence fails workforce admission closed. The HTTP
wrapper rebuilds the route from the configured public origin before provider
dispatch, preserving only the request path/query.

For the fleet internal PostgreSQL server, mount its public server certificate and
CA certificate read-only and set `WORKFORCE_DATABASE_TLS_CERT` and
`WORKFORCE_DATABASE_TLS_CA` to their container paths. The provider verifies the CA
and exact server leaf fingerprint; it removes driver DSN SSL overrides. A missing
certificate, changed leaf, or failed verification must be repaired through custody
and deployment rather than weakening TLS validation.

## Qualification

`pnpm test:workforce` owns disposable native PostgreSQL and Redis processes and
uses the production Next HTTP build plus the real Prisma/NextAuth session adapter.
It covers full migrations, replay, conditional writes, read credential rejection,
existing identity collisions, unknown/unassigned/alternate-provider denial,
native profile changes, self access, customer route denial, preserved owner access,
group-removal/session/OAuth revocation, mint-versus-disable ordering, retained
bindings and customer/team/service-key preservation. Build first with the documented
local test environment; the suite cannot prove a real ZITADEL network callback or
live deployment. Runtime qualification must exercise those separately before
assigning a human workforce identity. Deployment/qualification evidence belongs
in the owning GitHub issue.
