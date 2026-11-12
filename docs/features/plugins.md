# Plugins

Inkvoice ships optional features as **plugins**: statically compiled-in,
official modules an admin can enable or disable under **Settings → Plugins**.
Time Tracking is the first official plugin.

## Managing plugins

- Open **Settings → Plugins** (admin only). Each plugin lists its name,
  description, and an Enable/Disable toggle.
- Disabling a plugin hides its sidebar entry and its pages, and its API
  answers 404. Its data is kept; re-enabling restores everything.
- Plugins are on or off per install. Nothing is downloaded at runtime.

## The plugin catalog

The list of plugins you see under **Settings → Plugins** comes from a public
plugin catalog at `https://inkvoice.app/plugins/catalog.v1.json`. The catalog
carries each plugin's name, description, availability and latest version, so
the tab can also describe plugins that are planned or ship only with
Inkvoice Cloud.

- The app fetches the catalog **server-side**, on a 6 hour TTL. Your browser
  never talks to inkvoice.app directly; the server fetches the catalog from
  one URL and demand votes from another.
- A snapshot of the catalog ships with the app, so the Plugins tab works even
  with no internet at all. The remote catalog only ever improves on it.
- **Turning it off**: set the `plugin_catalog_url` setting to an empty string.
  This stops all catalog egress, including demand votes for planned plugins.
  The tab then shows the bundled snapshot only.
- When a plugin shows an update, it means a newer version of that plugin
  exists in a newer release of Inkvoice: upgrade Inkvoice to get it. Plugins
  are never updated in place.

A plugin can be blocked from enabling for five reasons:

| `blockedReason` | What it means for you |
|---|---|
| `null` | The enable switch works. |
| `planned` | The plugin does not exist yet. Vote for it if you want it built. |
| `cloud_only` | The plugin ships with Inkvoice Cloud only, not the self-hosted app. |
| `requires_feature` | The plugin needs a plan feature this install does not have. |
| `requires_app_upgrade` | This build of Inkvoice predates the plugin. Upgrade the app first. |

## Time Tracking

Track time against projects and turn unbilled hours into draft invoices.

- **Projects** group time by client work. A project can be linked to a
  customer with a default hourly rate. Project management is admin-only.
- **Timer**: start/stop a personal timer from the Time Tracking page. One
  running timer per user.
- **Entries**: manual or timer-captured time with duration, rate, and
  billable flag. Non-admin users see and edit only their own entries;
  admins see and manage all entries.
- **Summary**: per-project totals (total, billable, unbilled time and value).
- **Invoice from unbilled time**: pick a customer and date range to create a
  draft invoice from unbilled billable time (one line per project and rate).
  Requires invoice creation permission. Entries are marked billed and linked
  to the invoice.

## Leads

Track potential customers from first contact to a won quote. Off by default.

- **Leads** hold a contact name, company, email, phone, source, estimated
  value, stage (New, Contacted, Quoted, Won, Lost), next follow-up date and
  notes. Open leads sort by the soonest follow-up; overdue ones are flagged.
- **List or board**: a table with stage tabs, or a board you drag leads
  across to change their stage.
- **Convert to customer** creates a customer from the lead (named after the
  company, or the contact if there is none). Converting twice reuses it.
- **Create quote** converts the lead, moves it to Quoted and opens a new
  quote with that customer selected. When the customer accepts a quote, the
  lead moves to Won.
- **Export** the filtered list as CSV.
- Uses the existing customer permissions: reading leads needs
  `customers:read`, exporting `customers:export`, editing
  `customers:create`/`update`/`delete`, and
  starting a quote also needs `invoices:create`.

## API

Plugin endpoints live under `/api/v1/plugins/<plugin-id>/...` and require
authentication (session JWT or API token). Notes for integrators:

- `GET /api/v1/plugins` lists the catalog with per-install enablement.
- `PUT /api/v1/plugins/:id` toggles a plugin (admin only).
- `GET /api/v1/plugins/catalog` returns the full catalog view, merged with
  this install's state (any authenticated user).
- `POST /api/v1/plugins/catalog/refresh` forces a catalog re-sync, ignoring
  the TTL (admin only).
- `POST /api/v1/plugins/catalog/vote` registers interest in a planned plugin
  (any authenticated user).
- Scoped API tokens (tokens with an explicit scope list) are limited to the
  invoicing resources and cannot access plugin paths. Unscoped API tokens act
  as their owner and can access plugin endpoints.
