import Builder from "ophidian/build";
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const manifest = require("./manifest.json");

new Builder("src/pane-relief.ts")
.withWatch(new URL('', import.meta.url).pathname)
.withSass()
.withInstall(manifest.id)
.build();

