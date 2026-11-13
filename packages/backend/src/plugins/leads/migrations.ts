import type { PluginMigration } from "../registry";

// Leads schema. Tracked in plugin_schema_migrations under plugin_id = "leads".
export const leadsMigrations: PluginMigration[] = [
  {
    version: 1,
    name: "leads_table",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ld_leads (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          name TEXT NOT NULL,
          company TEXT,
          email TEXT,
          phone TEXT,
          source TEXT,
          value REAL,
          stage TEXT NOT NULL DEFAULT 'new',
          next_follow_up TEXT,
          notes TEXT,
          customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
          converted_at TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE INDEX IF NOT EXISTS idx_ld_leads_stage ON ld_leads(stage);
        CREATE INDEX IF NOT EXISTS idx_ld_leads_follow_up ON ld_leads(next_follow_up);
        CREATE INDEX IF NOT EXISTS idx_ld_leads_customer ON ld_leads(customer_id);
      `);
    },
  },
  {
    version: 2,
    name: "leads_project_link",
    up: (db) => {
      // The Time Tracking project made when a lead is won, so it's made once.
      const has = db
        .query("SELECT COUNT(*) AS n FROM pragma_table_info('ld_leads') WHERE name = 'project_id'")
        .get() as { n: number };
      if (!has.n) db.exec("ALTER TABLE ld_leads ADD COLUMN project_id TEXT");
    },
  },
  {
    version: 3,
    name: "leads_quote_events",
    up: (db) => {
      // quote_id: the quote a lead follows. events_seen: automation events
      // already handled (JSON array), so each fires once.
      const columns = new Set(
        (
          db.query("SELECT name FROM pragma_table_info('ld_leads')").all() as { name: string }[]
        ).map((c) => c.name),
      );
      if (!columns.has("quote_id")) db.exec("ALTER TABLE ld_leads ADD COLUMN quote_id TEXT");
      if (!columns.has("events_seen")) {
        db.exec("ALTER TABLE ld_leads ADD COLUMN events_seen TEXT");
        // Leads that already have a customer keep NULL: their first sync takes
        // the current state of their quotes as the starting point, so the
        // upgrade itself moves nothing. The rest start with nothing seen.
        db.exec("UPDATE ld_leads SET events_seen = '[]' WHERE customer_id IS NULL");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_ld_leads_quote ON ld_leads(quote_id)");
    },
  },
];
