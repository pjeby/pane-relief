import builder from "obsidian-rollup-presets";

export default builder()
.apply(c => c.output.sourcemap = "inline")
.assign({input: "src/pane-relief.ts"})
.withTypeScript()
.withInstall(__dirname)
.build();
