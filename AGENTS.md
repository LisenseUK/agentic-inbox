# Agent notes

## Deployment

- A push to `main` triggers the Cloudflare worker build and deploy. Avoid pushing broken work straight to `main`; use a branch if unsure.
- The build runs `pnpm install --frozen-lockfile`. It fails if `pnpm-lock.yaml` is out of date with `package.json`.
- Whenever `package.json` changes, regenerate the pnpm lockfile (`pnpm install --lockfile-only`) and commit it. `package-lock.json` is not used by the build.
