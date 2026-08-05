import tseslint from "typescript-eslint";
import pluginVue from "eslint-plugin-vue";
import vueParser from "vue-eslint-parser";
import houseStyle from "./tools/eslint-plugin-house-style/index.js";

/*
 * Boundaries are a build failure, not a review comment. The three rules below are
 * the whole architecture contract from CLAUDE.md, expressed where CI can see it.
 *
 *   beam-core     imports nothing
 *   beam-sources  imports core only
 *   beam-link     imports core only
 *   theme         imports no beam code
 *   apps/studio   imports all of the above
 *
 * Anything that wants to violate one of these is the wrong change.
 */
const NO_DOM = [
  "window",
  "document",
  "navigator",
  "DOMParser",
  "HTMLElement",
  "CanvasRenderingContext2D",
  "localStorage",
];

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "originals/**",
      "firmware/**",
      /* A rule that bans these characters has to contain them in order to match on
       * them. These are the only exempt files in the repo, and they are exempt
       * because they are the enforcement mechanisms themselves. */
      "tools/eslint-plugin-house-style/**",
      "tools/check-house-style.mjs",
    ],
  },

  ...tseslint.configs.recommended,

  /*
   * Single file components need their own parser: the TypeScript parser sees the
   * template and fails on the first tag. vue-eslint-parser handles the SFC and hands
   * the script block to the TS parser underneath, so both halves get linted, which
   * matters here because UI copy lives in templates and the house style rule has to
   * reach it.
   */
  ...pluginVue.configs["flat/recommended"],
  {
    files: ["**/*.vue"],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: "module" },
    },
    rules: {
      /* The design language is not PascalCase-in-template. Both shipped tools and
       * this app use plain tags, and renaming every component reference to satisfy
       * a style preference is churn with no reader benefit. */
      "vue/multi-word-component-names": "off",
      "vue/max-attributes-per-line": "off",
      "vue/singleline-html-element-content-newline": "off",
      "vue/html-self-closing": "off",
      "vue/attributes-order": "off",
      "vue/html-indent": "off",
      "vue/html-closing-bracket-newline": "off",
    },
  },

  {
    plugins: { "house-style": houseStyle },
    rules: {
      "house-style/no-dashes": "error",
      "house-style/no-emoji": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  /* beam-core is pure. No dependencies, no DOM, no framework, no sibling packages. */
  {
    files: ["packages/beam-core/src/**/*.ts"],
    languageOptions: { globals: {} },
    rules: {
      "no-restricted-globals": [
        "error",
        ...NO_DOM.map((name) => ({
          name,
          message:
            "beam-core is pure and runs headless in node. Take an injected primitive instead.",
        })),
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@virgilvox/*", "vue", "pinia"],
              message: "beam-core depends on nothing. Move this up a layer.",
            },
            {
              group: ["**/../beam-sources/**", "**/../beam-link/**", "**/../../theme/**"],
              message: "Dependencies point downward only.",
            },
          ],
        },
      ],
    },
  },

  /* sources and link may import core, and nothing else in the repo. */
  {
    files: ["packages/beam-sources/src/**/*.ts", "packages/beam-link/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["vue", "pinia", "**/../../theme/**", "**/../../apps/**"],
              message:
                "The SDK is framework agnostic. Vue lives only in theme and apps/studio.",
            },
          ],
        },
      ],
    },
  },

  /*
   * beam-sources is allowed to need a DOM primitive, but never to reach for one
   * itself: svg.ts takes a parseXml function, raster.ts takes a grayscale buffer.
   * That is what keeps every source testable under vitest with a shim.
   */
  {
    files: ["packages/beam-sources/src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        ...NO_DOM.map((name) => ({
          name,
          message:
            "Take an injected primitive. The app passes the real one, tests pass a shim.",
        })),
      ],
    },
  },

  /* The theme is presentational. It knows nothing about lasers. */
  {
    files: ["theme/**/*.{ts,vue,js}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@virgilvox/beam-*", "**/packages/**", "**/stores/**"],
              message:
                "The theme imports no beam code and no store. Props in, events out.",
            },
          ],
        },
      ],
    },
  },

  /* App components talk to the session facade and to plain data. Never to internals. */
  {
    files: ["apps/studio/src/**/*.{ts,vue}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@virgilvox/beam-*/src/*", "@virgilvox/beam-*/dist/*"],
              message: "Import the package entry point, never its internals.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["**/*.test.ts", "**/testing/**/*.ts"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-imports": "off",
    },
  },
);
