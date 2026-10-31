// Flat ESLint config: strict TypeScript, no console in app code, React hooks rules for the web app.
import js from "@eslint/js"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"

export default tseslint.config(
    {
        ignores: [
            "**/node_modules/**",
            "**/dist/**",
            "server/terse/generated/**",
            "actor/.durable-actors/**",
            ".local/**",
            "eslint.config.js",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.strict,
    {
        languageOptions: { globals: { ...globals.node, ...globals.browser } },
        rules: {
            "no-console": "error",
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
            "prefer-const": "error",
            "no-var": "error",
        },
    },
    {
        files: ["web/src/**/*.{ts,tsx}"],
        plugins: { "react-hooks": reactHooks },
        rules: { ...reactHooks.configs.recommended.rules },
    },
    {
        // Tests may use non-null assertions freely.
        files: ["tests/**/*.ts"],
        rules: { "@typescript-eslint/no-non-null-assertion": "off" },
    },
)
