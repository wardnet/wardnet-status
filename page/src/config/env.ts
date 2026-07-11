// Build/runtime flags. `import.meta.env.PROD` strips the dev-only affordances
// (MSW + the scenario switcher) from production bundles via dead-code elimination.

/** Use the in-browser MSW mock layer instead of a real worker behind /api. */
export const MSW_ENABLED =
  import.meta.env.DEV && import.meta.env.VITE_ENABLE_MSW !== "false";
