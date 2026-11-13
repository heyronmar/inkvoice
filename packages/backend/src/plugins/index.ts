// Official OSS plugins. Side-effect imports register each plugin at module
// load. app.ts imports this barrel so the registry is populated before
// runPluginMigrations() and route mounting.

// Plugins from heyronmar/inkvoice-plugins (git submodule at packages/inkvoice-plugins).
import "../../../inkvoice-plugins/plugins/leads/backend";
import "./time-tracker";
