# Next.js App Router Setup

This project is now configured as a minimal [Next.js](https://nextjs.org/) application using the App Router. It includes TypeScript support and Material UI dependencies.

## .aws
Folder contains aws realted files

## Getting Started

Install dependencies (uses pnpm):

```bash
pnpm install
```

Run the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) to see the result. You can start editing the UI by modifying files in the `app/` directory; the page auto-updates as you edit the file.

## Available Scripts (pnpm)

- `pnpm dev` – Starts the development server.
- `pnpm build` – Builds the production application.
- `pnpm start` – Runs the production build locally.
- `pnpm lint` – Runs ESLint using the Next.js shareable config.

## Project Structure

```
app/
  globals.css      # Global styles applied to the entire app
  layout.tsx       # Root layout shared across routes
  page.tsx         # Home page rendered at the index route
next.config.ts     # Next.js configuration file
```
