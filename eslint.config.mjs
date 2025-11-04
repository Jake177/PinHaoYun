import next from "eslint-config-next";

export default [
  {
    ignores: ["**/node_modules/*", "**/.next/*", "dist"],
  },
  ...next,
];
