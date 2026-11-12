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
];
