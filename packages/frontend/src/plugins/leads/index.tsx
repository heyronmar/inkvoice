// Leads frontend registration: a protected route (guarded by PluginGuard), a
// sidebar item under Plugins, its i18n, and its entry in the admin Plugins tab.

import { Target } from "lucide-react";
import { registerNavItem } from "@/nav-registry";
import { registerRoute } from "@/route-registry";
import { PluginGuard } from "../PluginGuard";
import { registerPlugin } from "../registry";
import "./i18n";
import LeadsPage from "./LeadsPage";
import LeadsSettings from "./LeadsSettings";

const PLUGIN_ID = "leads";

registerRoute({
  path: "/leads",
  element: (
    <PluginGuard pluginId={PLUGIN_ID}>
      <LeadsPage />
    </PluginGuard>
  ),
  scope: "protected",
});

registerNavItem({
  to: "/leads",
  labelKey: "leads.nav",
  icon: Target,
  section: "nav.plugins",
  pluginId: PLUGIN_ID,
});

registerPlugin({
  id: PLUGIN_ID,
  nameKey: "leads.name",
  descriptionKey: "leads.description",
  icon: Target,
  settings: LeadsSettings,
});
