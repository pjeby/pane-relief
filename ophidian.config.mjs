import Builder from "@ophidian/build";
import {readFileSync} from "node:fs"

new Builder("src/pane-relief.ts")
.assign({banner: {css: readFileSync("./style-settings.css", "utf-8")}})
.withWatch("style-settings.css")
.withSass()
.withInstall()
.build();

