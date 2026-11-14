import { defineConfig } from "astro/config";
import solid from "@astrojs/solid-js";
import react from "@astrojs/react";

export default defineConfig({
  output: "static",
  // Solid is the site's framework. React is only used for the Cabal Corner agent chat island
  // (assistant-ui), kept in src/components/react/ so the two JSX runtimes never overlap.
  integrations: [solid({ exclude: ["**/components/react/**"] }), react({ include: ["**/components/react/**"] })],
  build: { format: "file" },
});
